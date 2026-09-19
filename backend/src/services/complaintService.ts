import { ApiResponse, Complaint, ComplaintDetail, ComplaintWithCredit, Volunteer } from '../types';
import pool from '../db/pool';
import { logCreditChange, recalculateCreditScore } from './creditService';
import { calculateLevel } from './badgeService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

const COMPLAINT_WINDOW_DAYS = 7;

export const createComplaint = async (
  volunteerId: string,
  serviceRecordId: string,
  complaintType: string,
  description: string,
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

    const recordResult = await client.query(
      `SELECT id, volunteer_id, points_earned, status, recorded_at,
              (recorded_at >= NOW() - INTERVAL '1 day' * $2) AS within_seven_days
       FROM service_records
       WHERE id = $1
       FOR UPDATE`,
      [serviceRecordId, COMPLAINT_WINDOW_DAYS]
    );

    if (recordResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.recordNotFound };
    }

    const record = recordResult.rows[0];

    if (record.volunteer_id !== volunteerId) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.recordNotBelong };
    }

    if (record.status !== 'active') {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.recordAlreadyVoided };
    }

    if (!record.within_seven_days) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.recordTooOld };
    }

    const existingResult = await client.query(
      'SELECT id FROM complaints WHERE service_record_id = $1',
      [serviceRecordId]
    );

    if (existingResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.recordAlreadyComplained };
    }

    const result = await client.query(
      `INSERT INTO complaints (volunteer_id, service_record_id, complainant_id, complaint_type, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [volunteerId, serviceRecordId, complainantId, complaintType, description]
    );

    const newComplaint = result.rows[0];

    await client.query('COMMIT');

    const creditResult = await recalculateCreditScore(volunteerId);
    if (creditResult && creditResult.changeAmount !== 0) {
      await logCreditChange(
        volunteerId,
        creditResult.changeAmount,
        `投诉创建-信用分重算: ${complaintType}`,
        creditResult.beforeScore,
        creditResult.afterScore,
        newComplaint.id,
        'complaint'
      );
    }

    return {
      success: true,
      data: {
        ...newComplaint,
        creditScore: creditResult?.afterScore,
        creditChange: creditResult?.changeAmount,
        creditBreakdown: creditResult?.breakdown,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as { code?: string })?.code === '23505') {
      return { success: false, error: messages.complaints.recordAlreadyComplained };
    }
    logger.error(messages.logs.createComplaintFailed, error);
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
    let query = 'SELECT * FROM complaints WHERE 1=1';
    let countQuery = 'SELECT COUNT(*) as total FROM complaints WHERE 1=1';
    const params: any[] = [];
    const countParams: any[] = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND status = $${paramIndex}`;
      countQuery += ` AND status = $${paramIndex}`;
      params.push(status);
      countParams.push(status);
      paramIndex++;
    }

    if (volunteerId) {
      query += ` AND volunteer_id = $${paramIndex}`;
      countQuery += ` AND volunteer_id = $${paramIndex}`;
      params.push(volunteerId);
      countParams.push(volunteerId);
      paramIndex++;
    }

    query += ' ORDER BY created_at DESC';

    const countResult = await client.query(countQuery, countParams);

    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(pageSize, offset);

    const result = await client.query(query, params);

    return {
      success: true,
      data: {
        complaints: result.rows,
        pagination: {
          page,
          page_size: pageSize,
          total: parseInt(countResult.rows[0].total),
          total_pages: Math.ceil(parseInt(countResult.rows[0].total) / pageSize),
        },
      },
    };
  } finally {
    client.release();
  }
};

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
      'SELECT * FROM complaints WHERE id = $1',
      [complaintId]
    );

    if (complaintResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.notFound };
    }

    const complaint = complaintResult.rows[0] as Complaint;

    if (action === 'reject') {
      const rejectResult = await client.query(
        `UPDATE complaints
         SET status = 'rejected', resolution = $1, handled_by = $2, resolved_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND status = 'pending'
         RETURNING *`,
        [resolution, handledBy, complaintId]
      );

      if (rejectResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return { success: false, error: messages.complaints.alreadyHandled };
      }

      await client.query('COMMIT');

      const creditResult = await recalculateCreditScore(complaint.volunteer_id);
      if (creditResult && creditResult.changeAmount !== 0) {
        await logCreditChange(
          complaint.volunteer_id,
          creditResult.changeAmount,
          '投诉驳回-信用分重算',
          creditResult.beforeScore,
          creditResult.afterScore,
          complaintId,
          'complaint'
        );
      }

      return {
        success: true,
        message: messages.complaints.rejected,
        data: creditResult ? {
          creditScore: creditResult.afterScore,
          creditChange: creditResult.changeAmount,
          creditBreakdown: creditResult.breakdown,
        } : undefined,
      };
    }

    if (!complaint.service_record_id) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.recordNotFound };
    }

    const claimResult = await client.query(
      `UPDATE complaints
       SET status = 'resolved', resolution = $1, handled_by = $2, resolved_at = CURRENT_TIMESTAMP
       WHERE id = $3 AND status = 'pending'
       RETURNING *`,
      [resolution, handledBy, complaintId]
    );

    if (claimResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.alreadyHandled };
    }

    const recordResult = await client.query(
      `SELECT id, volunteer_id, points_earned, status, service_type
       FROM service_records
       WHERE id = $1
       FOR UPDATE`,
      [complaint.service_record_id]
    );

    if (recordResult.rows.length === 0 || recordResult.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.recordAlreadyVoided };
    }

    const record = recordResult.rows[0];
    const originalPoints = record.points_earned || 0;

    const voidResult = await client.query(
      `UPDATE service_records
       SET status = 'voided',
           voided_at = CURRENT_TIMESTAMP,
           void_reason = $1,
           voided_by_complaint_id = $2
       WHERE id = $3 AND status = 'active'`,
      [`投诉受理作废: ${resolution}`, complaintId, record.id]
    );

    if (voidResult.rowCount !== 1) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.complaints.recordAlreadyVoided };
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
    const beforePoints = volunteer.total_points;
    const newTotalPoints = Math.max(0, beforePoints - originalPoints);
    const revokedPoints = beforePoints - newTotalPoints;
    const newLevel = calculateLevel(newTotalPoints);

    await client.query(
      `UPDATE volunteers
       SET total_points = $1, level = $2
       WHERE id = $3`,
      [newTotalPoints, newLevel, volunteer.id]
    );

    await client.query(
      `INSERT INTO points_logs (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'complaint')`,
      [volunteer.id, -revokedPoints, `投诉受理撤销积分: ${complaint.complaint_type}`, beforePoints, newTotalPoints, complaintId]
    );

    await client.query(
      `UPDATE complaints
       SET original_points = $1, revoked_points = $2, points_penalty = $2
       WHERE id = $3`,
      [originalPoints, revokedPoints, complaintId]
    );

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, new_value, reason)
       VALUES ($1, 'resolve_complaint', 'complaint', $2, $3, $4)`,
      [handledBy, complaintId, {
        serviceRecordId: record.id,
        originalPoints,
        revokedPoints,
        beforePoints,
        afterPoints: newTotalPoints,
      }, resolution]
    );

    await client.query('COMMIT');

    const creditResult = await recalculateCreditScore(complaint.volunteer_id);
    if (creditResult && creditResult.changeAmount !== 0) {
      await logCreditChange(
        complaint.volunteer_id,
        creditResult.changeAmount,
        `投诉受理-信用分重算: ${complaint.complaint_type}`,
        creditResult.beforeScore,
        creditResult.afterScore,
        complaintId,
        'complaint'
      );
    }

    return {
      success: true,
      data: {
        message: messages.complaints.resolved,
        serviceRecordId: record.id,
        originalPoints,
        revokedPoints,
        beforePoints,
        newTotalPoints,
        newLevel,
        creditScore: creditResult?.afterScore,
        creditChange: creditResult?.changeAmount,
        creditBreakdown: creditResult?.breakdown,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.handleComplaintFailed, error);
    return { success: false, error: messages.complaints.handleFailed };
  } finally {
    client.release();
  }
};

export const getComplaintById = async (
  complaintId: string
): Promise<ApiResponse<ComplaintDetail>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT c.*, row_to_json(sr) AS service_record
       FROM complaints c
       LEFT JOIN service_records sr ON sr.id = c.service_record_id
       WHERE c.id = $1`,
      [complaintId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.complaints.notFound };
    }

    const complaint = result.rows[0];

    const revocationResult = await client.query(
      `SELECT * FROM points_logs
       WHERE related_id = $1 AND related_type = 'complaint'
       ORDER BY created_at DESC
       LIMIT 1`,
      [complaintId]
    );

    return {
      success: true,
      data: {
        ...complaint,
        service_record: complaint.service_record || null,
        revocation: revocationResult.rows[0] || null,
      },
    };
  } finally {
    client.release();
  }
};
