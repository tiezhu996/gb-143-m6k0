import { QueryResult } from 'pg';
import {
  ApiResponse,
  Complaint,
  ComplaintDetail,
  ComplaintRevocationResult,
  ComplaintWithCredit,
  ServiceRecord,
  Volunteer,
} from '../types';
import pool from '../db/pool';
import { calculateLevel } from './badgeService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

// 仅允许投诉近七天内发生的服务记录
const COMPLAINT_WINDOW_DAYS = 7;

const buildRevocationResult = (
  row: Complaint,
  beforePoints?: number,
  afterPoints?: number
): ComplaintRevocationResult | null => {
  if (row.status !== 'resolved' || !row.service_record_id) {
    return null;
  }
  return {
    complaintId: row.id,
    serviceRecordId: row.service_record_id,
    volunteerId: row.volunteer_id,
    originalPoints: row.original_points,
    revokedPoints: row.revoked_points,
    beforePoints: beforePoints ?? row.original_points,
    afterPoints: afterPoints ?? Math.max(0, row.original_points - row.revoked_points),
    result: row.revocation_result ?? '',
  };
};

/**
 * 创建投诉。
 * 规则：
 * 1. 必须绑定具体服务记录（service_record_id 必填）；
 * 2. 该记录必须属于被投诉志愿者；
 * 3. 记录发生时间必须在近七天内；
 * 4. 该记录此前未被投诉过（任何状态的投诉都不允许），且不能是已作废记录；
 * 5. 同一记录只允许一条待处理投诉（数据库部分唯一索引兜底并发）。
 */
export const createComplaint = async (
  volunteerId: string,
  complaintType: string,
  description: string,
  serviceRecordId: string,
  complainantId?: string
): Promise<ApiResponse<ComplaintWithCredit>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const volunteerResult = await client.query(
      'SELECT id FROM volunteers WHERE id = $1',
      [volunteerId]
    );
    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    // 锁定目标记录，防止与并发受理竞态
    const recordResult: QueryResult<ServiceRecord> = await client.query(
      'SELECT * FROM service_records WHERE id = $1 FOR UPDATE',
      [serviceRecordId]
    );
    if (recordResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.recordNotFound };
    }

    const record = recordResult.rows[0];

    if (record.volunteer_id !== volunteerId) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.recordOwnerMismatch };
    }

    const ageMs = Date.now() - new Date(record.recorded_at as Date).getTime();
    if (Number.isNaN(ageMs) || ageMs < 0 || ageMs > COMPLAINT_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.recordOutOfRange };
    }

    if (record.is_void) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.recordAlreadyVoid };
    }

    // 此前未被投诉：任何状态的历史投诉都不允许（一条记录生命周期内只可投诉成功一次）
    const existed = await client.query(
      'SELECT id, status FROM complaints WHERE service_record_id = $1 LIMIT 1',
      [serviceRecordId]
    );
    if (existed.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.recordAlreadyComplained };
    }

    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO complaints
           (volunteer_id, complainant_id, service_record_id, original_points,
            complaint_type, description, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         RETURNING *`,
        [
          volunteerId,
          complainantId ?? null,
          serviceRecordId,
          record.points_earned ?? 0,
          complaintType,
          description,
        ]
      );
    } catch (dbError: any) {
      // 并发下命中 uq_complaints_pending_per_record 部分唯一索引
      if (dbError && dbError.code === '23505') {
        await client.query('ROLLBACK');
        return { success: false, error: messages.complaints.duplicatePending };
      }
      throw dbError;
    }

    await client.query('COMMIT');

    return {
      success: true,
      data: inserted.rows[0] as ComplaintWithCredit,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    logger.error(messages.complaints.createFailed, error);
    return { success: false, error: messages.complaints.createFailed };
  } finally {
    client.release();
  }
};

export const getComplaints = async (
  page: number = 1,
  pageSize: number = 20,
  status?: string,
  volunteerId?: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;
    const where: string[] = [];
    const params: any[] = [];

    if (status) {
      params.push(status);
      where.push(`c.status = $${params.length}`);
    }
    if (volunteerId) {
      params.push(volunteerId);
      where.push(`c.volunteer_id = $${params.length}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await client.query(
      `SELECT COUNT(*)::int AS total FROM complaints c ${whereSql}`,
      params
    );

    const listParams = [...params, pageSize, offset];
    const result = await client.query(
      `SELECT c.*,
              row_to_json(s) AS service_record
         FROM complaints c
         LEFT JOIN service_records s ON s.id = c.service_record_id
         ${whereSql}
         ORDER BY c.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams
    );

    const complaints = result.rows.map((row) => {
      const { service_record, ...complaint } = row;
      return { ...complaint, service_record: service_record ?? null };
    });

    return {
      success: true,
      data: {
        complaints,
        pagination: {
          page,
          page_size: pageSize,
          total: countResult.rows[0].total,
          total_pages: Math.ceil(countResult.rows[0].total / pageSize),
        },
      },
    };
  } finally {
    client.release();
  }
};

/**
 * 处理投诉。
 * - reject（驳回）：只写处理意见，不动积分、不作废记录；
 * - resolve（受理）：在同一事务内
 *     1) 原子地把投诉从 pending 置为 resolved（重复/并发受理只有一个请求能改到行）；
 *     2) 将关联服务记录作废（保留数据，标记 is_void）；
 *     3) 按原所得积分（original_points）一次性从志愿者累计积分中扣减；
 *     4) 写清原积分 original_points、撤销积分 revoked_points 和处理结果 revocation_result；
 *     5) 写积分流水与审计日志。
 * 失败请求（重复、并发落败、记录已作废等）不改任何积分。
 */
export const handleComplaint = async (
  complaintId: string,
  action: 'resolve' | 'reject',
  handledBy: string,
  resolution: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const complaintResult = await client.query(
      'SELECT * FROM complaints WHERE id = $1 FOR UPDATE',
      [complaintId]
    );
    if (complaintResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.notFound };
    }
    const complaint = complaintResult.rows[0] as Complaint;

    // 行锁 + 状态守卫：重复提交或并发受理只有一次生效
    if (complaint.status !== 'pending') {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.alreadyHandled };
    }

    // 驳回仅留意见：不扣积分、不作废记录
    if (action === 'reject') {
      await client.query(
        `UPDATE complaints
            SET status = 'rejected',
                resolution = $1,
                revocation_result = NULL,
                revoked_points = 0,
                handled_by = $2,
                resolved_at = CURRENT_TIMESTAMP
          WHERE id = $3 AND status = 'pending'`,
        [resolution, handledBy, complaintId]
      );

      await client.query(
        `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, reason)
         VALUES ($1, 'reject_complaint', 'complaint', $2, $3)`,
        [handledBy, complaintId, resolution]
      );

      await client.query('COMMIT');
      return {
        success: true,
        message: messages.complaints.rejected,
        data: {
          id: complaintId,
          status: 'rejected',
          resolution,
          pointsChanged: false,
        },
      };
    }

    // 受理：再次锁定并校验服务记录
    if (!complaint.service_record_id) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.recordRequired };
    }

    const recordResult = await client.query(
      'SELECT * FROM service_records WHERE id = $1 FOR UPDATE',
      [complaint.service_record_id]
    );
    if (recordResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.recordNotFound };
    }
    const record = recordResult.rows[0] as ServiceRecord;
    if (record.is_void) {
      // 记录已作废意味着积分撤销已生效过一次，本次受理必须失败且不改积分
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.alreadyHandled };
    }

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
      [complaint.volunteer_id]
    );
    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }
    const volunteer = volunteerResult.rows[0] as Volunteer;

    // 按原所得积分一次性扣减（以投诉创建时快照为准，避免记录事后被篡改）
    const originalPoints = complaint.original_points;
    const revokedPoints = originalPoints;
    const beforePoints = volunteer.total_points;
    const afterPoints = Math.max(0, beforePoints - revokedPoints);
    const newLevel = calculateLevel(afterPoints);

    const resultText =
      `投诉受理成立，服务记录 ${complaint.service_record_id} 作废；` +
      `原所得积分 ${originalPoints} 分已一次性撤销，累计积分 ${beforePoints} -> ${afterPoints}。`;

    // 原子状态翻转：即便绕过上面的守卫，并发受理也只会有一条 UPDATE 命中
    const flipped = await client.query(
      `UPDATE complaints
          SET status = 'resolved',
              resolution = $1,
              revocation_result = $2,
              original_points = $3,
              revoked_points = $4,
              points_penalty = $5,
              handled_by = $6,
              resolved_at = CURRENT_TIMESTAMP
        WHERE id = $7 AND status = 'pending'`,
      [resolution, resultText, originalPoints, revokedPoints, revokedPoints, handledBy, complaintId]
    );
    if (flipped.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.alreadyHandled };
    }

    await client.query(
      `UPDATE volunteers
          SET total_points = $1, level = $2
        WHERE id = $3`,
      [afterPoints, newLevel, volunteer.id]
    );

    await client.query(
      `UPDATE service_records
          SET is_void = true,
              voided_by_complaint_id = $1
        WHERE id = $2 AND is_void = false`,
      [complaintId, record.id]
    );

    await client.query(
      `INSERT INTO points_logs
         (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'complaint_revocation')`,
      [
        volunteer.id,
        -revokedPoints,
        `投诉受理撤销记录积分: ${complaint.complaint_type}（原积分 ${originalPoints}）`,
        beforePoints,
        afterPoints,
        complaintId,
      ]
    );

    await client.query(
      `INSERT INTO admin_audit_logs
         (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, 'resolve_complaint', 'complaint', $2, $3, $4, $5)`,
      [
        handledBy,
        complaintId,
        { originalPoints, beforePoints },
        { revokedPoints, afterPoints, serviceRecordId: record.id },
        `${resolution} | ${resultText}`,
      ]
    );

    await client.query('COMMIT');

    const revocation: ComplaintRevocationResult = {
      complaintId,
      serviceRecordId: record.id!,
      volunteerId: volunteer.id,
      originalPoints,
      revokedPoints,
      beforePoints,
      afterPoints,
      result: resultText,
    };

    return {
      success: true,
      message: messages.complaints.resolved,
      data: {
        id: complaintId,
        status: 'resolved',
        resolution,
        revocation,
        newTotalPoints: afterPoints,
        newLevel,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    logger.error(messages.logs.handleComplaintFailed, error);
    return { success: false, error: messages.complaints.handleFailed };
  } finally {
    client.release();
  }
};

/**
 * 投诉详情。
 * 刷新后仍可读到：被投诉（可能已作废）的服务记录、原积分、撤销积分与受理结果。
 */
export const getComplaintById = async (
  complaintId: string
): Promise<ApiResponse<ComplaintDetail>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT c.*,
              row_to_json(s) AS service_record
         FROM complaints c
         LEFT JOIN service_records s ON s.id = c.service_record_id
        WHERE c.id = $1`,
      [complaintId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.complaints.notFound };
    }

    const { service_record, ...complaint } = result.rows[0];

    // 从撤销流水读取当时的前后累计积分，保证刷新后看到的结果与受理时一致
    let beforePoints: number | undefined;
    let afterPoints: number | undefined;
    if (complaint.status === 'resolved') {
      const logResult = await client.query(
        `SELECT before_points, after_points
           FROM points_logs
          WHERE related_id = $1 AND related_type = 'complaint_revocation'
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [complaintId]
      );
      if (logResult.rows.length > 0) {
        beforePoints = logResult.rows[0].before_points;
        afterPoints = logResult.rows[0].after_points;
      }
    }

    const detail: ComplaintDetail = {
      ...(complaint as Complaint),
      service_record: service_record ?? null,
      revocation: buildRevocationResult(complaint as Complaint, beforePoints, afterPoints),
    };

    return { success: true, data: detail };
  } finally {
    client.release();
  }
};
