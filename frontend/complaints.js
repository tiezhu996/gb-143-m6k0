'use strict';

const API_BASE = '/api/v1';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const state = {
  volunteerId: '',
  records: [],
  complaints: [],
  selectedRecordId: '',
};

const $ = (id) => document.getElementById(id);

const toast = (message, type = '') => {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${type}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add('hidden'), 3200);
};

const setApiStatus = (ok) => {
  const el = $('api-status');
  el.textContent = ok ? '后端已连接' : '后端未连接';
  el.className = `api-status ${ok ? 'online' : 'offline'}`;
};

const authHeaders = (extra = {}) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${$('admin-token').value.trim() || 'admin-token'}`,
  ...extra,
});

const apiRequest = async (path, options = {}) => {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: authHeaders(options.headers),
    ...options,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }
  if (!response.ok || (payload && payload.success === false)) {
    const error = new Error((payload && payload.error) || `请求失败：${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
};

const TYPE_NAMES = {
  no_show: '爽约',
  poor_attitude: '态度恶劣',
  violation: '违规操作',
  misconduct: '不当行为',
  other: '其他',
};

const STATUS_NAMES = { pending: '待处理', resolved: '已受理', rejected: '已驳回' };

const formatTime = (value) => {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
};

const isWithinSevenDays = (recordedAt) => {
  const age = Date.now() - new Date(recordedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age <= SEVEN_DAYS_MS;
};

const escapeHtml = (raw) => String(raw ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

const loadRecordsAndComplaints = async () => {
  const volunteerId = $('volunteer-id').value.trim();
  if (!volunteerId) {
    toast('请先填写志愿者ID', 'error');
    return;
  }
  state.volunteerId = volunteerId;
  state.selectedRecordId = '';
  $('service-record-id').value = '';
  $('selected-record').textContent = '尚未选择服务记录';
  $('selected-record').classList.remove('filled');

  try {
    const [recordsData, complaintsData] = await Promise.all([
      apiRequest(`/service-records/volunteer/${volunteerId}?page=1&page_size=100`),
      apiRequest(`/complaints?volunteer_id=${volunteerId}&page=1&page_size=100`),
    ]);
    setApiStatus(true);
    state.records = (recordsData.data && recordsData.data.records) || [];
    state.complaints = (complaintsData.data && complaintsData.data.complaints) || [];
    renderRecords();
    renderComplaints();
    toast('已加载服务记录与投诉', 'success');
  } catch (error) {
    setApiStatus(false);
    toast(error.message || '加载失败', 'error');
  }
};

// 可投诉：属于该志愿者（接口已按志愿者过滤）、近七天内、未作废、此前未被投诉
const recordComplaintStatus = (record) => {
  const linked = state.complaints.find((c) => c.service_record_id === record.id);
  if (linked) {
    return { choosable: false, reason: `此前已投诉（${STATUS_NAMES[linked.status] || linked.status}）`, linked };
  }
  if (record.is_void) return { choosable: false, reason: '记录已作废' };
  if (!isWithinSevenDays(record.recorded_at)) return { choosable: false, reason: '超出近七天投诉期限' };
  return { choosable: true, reason: '可发起投诉' };
};

const renderRecords = () => {
  const container = $('records');
  if (state.records.length === 0) {
    container.innerHTML = '<p class="hint">该志愿者暂无服务记录。</p>';
    return;
  }
  container.innerHTML = state.records.map((record) => {
    const info = recordComplaintStatus(record);
    const classes = ['record-card'];
    if (record.is_void) classes.push('void');
    if (info.choosable) classes.push('choosable');
    if (state.selectedRecordId === record.id) classes.push('selected');
    return `
      <div class="${classes.join(' ')}" data-record-id="${escapeHtml(record.id)}">
        <div>
          <div><strong>${escapeHtml(TYPE_NAMES[record.service_type] || record.service_type)}</strong>
            ${record.is_void ? '<span class="badge-void">已作废</span>' : ''}
          </div>
          <div class="record-meta">
            时间：${formatTime(record.recorded_at)} ｜ 时长：${escapeHtml(record.duration_hours)}h
            ｜ 评分：${escapeHtml(record.rating)} ｜ <span class="record-points">原积分 ${escapeHtml(record.points_earned)}</span>
          </div>
          <div class="record-meta">${escapeHtml(info.reason)}</div>
        </div>
        ${info.choosable ? '<button class="btn btn-primary btn-pick" type="button">选择投诉</button>' : ''}
      </div>`;
  }).join('');

  container.querySelectorAll('.btn-pick').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      pickRecord(button.closest('.record-card').dataset.recordId);
    });
  });
  container.querySelectorAll('.record-card.choosable').forEach((card) => {
    card.addEventListener('click', () => pickRecord(card.dataset.recordId));
  });
};

const pickRecord = (recordId) => {
  const record = state.records.find((item) => item.id === recordId);
  if (!record) return;
  state.selectedRecordId = recordId;
  $('service-record-id').value = recordId;
  $('selected-record').textContent =
    `已选择：${TYPE_NAMES[record.service_type] || record.service_type} ｜ ${formatTime(record.recorded_at)} ｜ 原积分 ${record.points_earned}`;
  $('selected-record').classList.add('filled');
  renderRecords();
};

const submitComplaint = async (event) => {
  event.preventDefault();
  const serviceRecordId = $('service-record-id').value;
  const description = $('complaint-description').value.trim();
  if (!serviceRecordId) {
    toast('请先选择一条可投诉的服务记录', 'error');
    return;
  }
  if (description.length < 5) {
    toast('投诉说明不少于5个字', 'error');
    return;
  }
  try {
    await apiRequest('/complaints', {
      method: 'POST',
      body: JSON.stringify({
        volunteer_id: state.volunteerId,
        service_record_id: serviceRecordId,
        complaint_type: $('complaint-type').value,
        description,
      }),
    });
    toast('投诉已提交，进入待处理', 'success');
    $('complaint-description').value = '';
    await loadRecordsAndComplaints();
  } catch (error) {
    toast(error.message || '投诉提交失败', 'error');
  }
};

const handleComplaintAction = async (complaintId, action, resolution) => {
  try {
    const result = await apiRequest(`/complaints/${complaintId}/handle`, {
      method: 'POST',
      body: JSON.stringify({ action, resolution }),
    });
    toast(action === 'resolve' ? '已受理：记录作废，原积分一次性撤销' : '已驳回：仅保留意见', 'success');
    if (action === 'resolve' && result.data && result.data.revocation) {
      const r = result.data.revocation;
      toast(`撤销 ${r.revokedPoints} 分：${r.beforePoints} → ${r.afterPoints}`, 'success');
    }
    await loadRecordsAndComplaints();
  } catch (error) {
    // 重复或同时受理：后端只让一次生效，失败请求不会改动积分
    toast(error.message || '处理失败', 'error');
    await loadRecordsAndComplaints();
  }
};

const renderComplaints = () => {
  const filter = $('status-filter').value;
  const list = state.complaints.filter((item) => !filter || item.status === filter);
  const container = $('complaints');
  if (list.length === 0) {
    container.innerHTML = '<p class="hint">暂无投诉记录。</p>';
    return;
  }
  container.innerHTML = list.map((item) => {
    const record = item.service_record;
    const revocationHtml = item.status === 'resolved' ? `
      <div class="revocation-box">
        <strong>撤销结果</strong>
        <dl>
          <dt>原所得积分</dt><dd>${escapeHtml(item.original_points)}</dd>
          <dt>撤销积分</dt><dd>-${escapeHtml(item.revoked_points)}</dd>
          <dt>结果说明</dt><dd>${escapeHtml(item.revocation_result || item.resolution || '')}</dd>
        </dl>
      </div>` : '';
    const actionsHtml = item.status === 'pending' ? `
      <div class="complaint-actions">
        <textarea rows="2" placeholder="填写处理意见（驳回仅留意见；受理将作废记录并扣减原积分）"
          data-opinion="${escapeHtml(item.id)}"></textarea>
        <button class="btn btn-danger btn-reject" data-id="${escapeHtml(item.id)}" type="button">驳回</button>
        <button class="btn btn-success btn-resolve" data-id="${escapeHtml(item.id)}" type="button">受理并撤销积分</button>
      </div>` : '';
    return `
      <article class="complaint-card">
        <div class="complaint-head">
          <div>
            <strong>${escapeHtml(TYPE_NAMES[item.complaint_type] || item.complaint_type)}</strong>
            <span class="status-tag status-${escapeHtml(item.status)}">${STATUS_NAMES[item.status] || item.status}</span>
          </div>
          <button class="btn btn-detail" data-id="${escapeHtml(item.id)}" type="button">查看详情</button>
        </div>
        <p class="complaint-desc">${escapeHtml(item.description)}</p>
        <div class="record-meta">
          绑定记录：${record ? `${escapeHtml(TYPE_NAMES[record.service_type] || record.service_type)}（${formatTime(record.recorded_at)}）` : '记录缺失'}
          ｜ 提交：${formatTime(item.created_at)}
        </div>
        ${revocationHtml}
        ${actionsHtml}
      </article>`;
  }).join('');

  container.querySelectorAll('.btn-reject').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.id;
      const opinion = container.querySelector(`[data-opinion="${id}"]`).value.trim();
      if (opinion.length < 5) return toast('处理意见不少于5个字', 'error');
      handleComplaintAction(id, 'reject', opinion);
    });
  });
  container.querySelectorAll('.btn-resolve').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.id;
      const opinion = container.querySelector(`[data-opinion="${id}"]`).value.trim();
      if (opinion.length < 5) return toast('处理意见不少于5个字', 'error');
      if (!window.confirm('受理后将作废该服务记录并一次性扣减原所得积分，确认继续？')) return;
      handleComplaintAction(id, 'resolve', opinion);
    });
  });
  container.querySelectorAll('.btn-detail').forEach((button) => {
    button.addEventListener('click', () => openDetail(button.dataset.id));
  });
};

// 详情刷新：直接请求后端，保证仍能读到争议记录（含作废状态）与撤销结果
const openDetail = async (complaintId) => {
  $('detail-mask').classList.remove('hidden');
  $('detail-body').innerHTML = '<p class="hint">加载中…</p>';
  try {
    const result = await apiRequest(`/complaints/${complaintId}`);
    const c = result.data;
    const record = c.service_record;
    const r = c.revocation;
    $('detail-body').innerHTML = `
      <section>
        <h3>投诉信息</h3>
        <p>${escapeHtml(c.description)}</p>
        <p class="record-meta">
          类型：${escapeHtml(TYPE_NAMES[c.complaint_type] || c.complaint_type)}
          ｜ 状态：${STATUS_NAMES[c.status] || c.status} ｜ 提交：${formatTime(c.created_at)}
        </p>
        <p class="record-meta">处理意见：${escapeHtml(c.resolution || '—')}</p>
      </section>
      <section>
        <h3>争议服务记录</h3>
        ${record ? `
          <p>${escapeHtml(TYPE_NAMES[record.service_type] || record.service_type)}
            ${record.is_void ? '<span class="badge-void">已作废</span>' : '<span class="status-tag status-pending">有效</span>'}
          </p>
          <p class="record-meta">
            发生时间：${formatTime(record.recorded_at)} ｜ 时长：${escapeHtml(record.duration_hours)}h
            ｜ 评分：${escapeHtml(record.rating)} ｜ 原所得积分：${escapeHtml(record.points_earned)}
          </p>` : '<p class="record-meta">关联记录已不存在</p>'}
      </section>
      <section>
        <h3>撤销结果</h3>
        ${r ? `
          <div class="revocation-box">
            <dl>
              <dt>原积分</dt><dd>${escapeHtml(r.originalPoints)}</dd>
              <dt>撤销积分</dt><dd>-${escapeHtml(r.revokedPoints)}</dd>
              <dt>扣减前累计</dt><dd>${escapeHtml(r.beforePoints)}</dd>
              <dt>扣减后累计</dt><dd>${escapeHtml(r.afterPoints)}</dd>
              <dt>结果</dt><dd>${escapeHtml(r.result)}</dd>
            </dl>
          </div>` : c.status === 'rejected'
            ? '<p class="record-meta">投诉已驳回，仅保留处理意见，积分未调整、记录未作废。</p>'
            : '<p class="record-meta">该投诉尚在待处理。</p>'}
      </section>`;
  } catch (error) {
    $('detail-body').innerHTML = `<p class="record-meta">${escapeHtml(error.message)}</p>`;
  }
};

$('btn-load').addEventListener('click', loadRecordsAndComplaints);
$('btn-refresh').addEventListener('click', loadRecordsAndComplaints);
$('complaint-form').addEventListener('submit', submitComplaint);
$('status-filter').addEventListener('change', renderComplaints);
$('btn-close-detail').addEventListener('click', () => $('detail-mask').classList.add('hidden'));
$('detail-mask').addEventListener('click', (event) => {
  if (event.target === $('detail-mask')) $('detail-mask').classList.add('hidden');
});
