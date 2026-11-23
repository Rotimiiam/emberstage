// Emberstage Portal SPA

function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
  return '';
}

const PROVIDERS = ['youtube', 'twitch', 'facebook'];
const YOUTUBE_LATENCIES = [
  { value: 'normal', label: 'Normal latency' },
  { value: 'low', label: 'Low latency' },
  { value: 'ultraLow', label: 'Ultra-low latency' }
];
const YOUTUBE_PRIVACY = [
  { value: 'private', label: 'Private' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'public', label: 'Public' }
];
const BILLING_RETURN_STORAGE_KEY = 'emberstage.billingReturn';
const BILLING_POLL_LIMIT = 4;
const BILLING_POLL_DELAY_MS = 3500;
const FREE_PLAN_FALLBACK = {
  name: 'Free local core',
  amount: 0,
  currency: 'NGN',
  interval: 'monthly',
  maxDevices: 0,
  maxDestinations: 0,
  maxActiveBroadcasts: 0
};

const state = {
  user: null,
  workspaces: [],
  activeWorkspaceId: null,
  activeWorkspaceRole: '',
  activeWorkspace: null,
  providers: {},
  providerTargets: [],
  customTargets: [],
  setup: { ingestServer: '', devices: [], stream: null, destinations: [] },
  selectedDeviceId: '',
  selectedYoutubeTargetId: '',
  youtubeBroadcasts: {},
  youtubeBroadcastSelections: {},
  youtubeThumbnailFiles: {},
  ingestCredentials: null,
  linkCode: null,
  bulkResults: [],
  isRegisterMode: false,
  linkCodeTimerInterval: null,
  listenersBound: false,
  drafts: {
    customTarget: { name: '', stream_url: '', stream_key: '' },
    youtubeCreate: {
      title: '',
      description: '',
      privacyStatus: 'private',
      scheduledStartTime: '',
      latencyPreference: 'normal',
      categoryId: ''
    },
    youtubeUpdate: {
      title: '',
      description: '',
      privacyStatus: 'private',
      latencyPreference: 'normal',
      categoryId: ''
    },
    youtubeBulk: {
      title: '',
      description: '',
      privacyStatus: 'private',
      latencyPreference: 'normal',
      categoryId: '',
      targetIds: []
    }
  },
  billing: {
    workspace: null,
    summaryError: '',
    returnFlow: null,
    pollTimer: null,
    stickyNotice: null
  },
  ui: {
    busy: {},
    sessionChecking: false,
    startupHold: false,
    authPending: false,
    authGeneration: 0,
    statuses: {},
    activeView: 'overview',
    lastLoadedAt: null,
    modal: {
      open: false,
      resolver: null,
      restoreFocusTo: null,
      card: null
    }
  }
};

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

const PORTAL_VIEWS = {
  overview: {
    title: 'Overview',
    subtitle: 'Enrollment, pairing, and billing for this workspace.'
  },
  broadcasts: {
    title: 'Broadcasts',
    subtitle: 'Select, create, update, and transition YouTube broadcasts.'
  },
  devices: {
    title: 'Devices',
    subtitle: 'Pair a device and manage encoder access.'
  },
  workspace: {
    title: 'Workspace',
    subtitle: 'Billing status, plan limits, and workspace access.'
  }
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function titleCase(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function maskSecret(value) {
  if (!value) return '••••••••';
  const last4 = String(value).slice(-4);
  return `••••••••••••${last4}`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function formatRelativeTime(value) {
  if (!value) return 'just now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'just now';
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (absolute < 60) return rtf.format(Math.round(seconds), 'second');
  if (absolute < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86400), 'day');
}

function toLocalDateTimeInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalDateTimeInput(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMoneyMinor(amount, currency = 'NGN') {
  const minor = Number(amount);
  if (!Number.isFinite(minor)) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: String(currency || 'NGN').toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(minor / 100);
}

function formatPlanInterval(interval) {
  if (!interval) return 'month';
  const normalized = String(interval).toLowerCase();
  if (normalized === 'monthly') return 'month';
  if (normalized === 'yearly' || normalized === 'annual') return 'year';
  return normalized.replace(/ly$/, '') || 'month';
}

function formatPlanPrice(plan) {
  if (!plan) return '—';
  const amount = Number(plan.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 'Free';
  return `${formatMoneyMinor(amount, plan.currency)}/${formatPlanInterval(plan.interval)}`;
}

function formatPaidUntil(value) {
  if (!value) return 'No paid access recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No paid access recorded';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function roleLabel(role) {
  const normalized = String(role || '').toLowerCase();
  if (normalized === 'owner') return 'Workspace owner';
  if (normalized === 'finance') return 'Finance';
  if (normalized === 'operator') return 'Operator';
  return 'Workspace member';
}

function isBillingManager(role = state.activeWorkspaceRole) {
  return ['owner', 'finance'].includes(String(role || '').toLowerCase());
}

function currentBillingMode() {
  return state.billing.workspace?.mode || state.billing.publicPlan?.mode || 'unconfigured';
}

function billingModeLabel(mode) {
  if (mode === 'test') return 'Test mode';
  if (mode === 'live') return 'Live mode';
  return 'Checkout not configured';
}

function billingModeCopy(mode) {
  if (mode === 'test') return 'Test mode is on. No real card charge should happen from this workspace.';
  if (mode === 'live') return isCheckoutAvailable() ? 'Live payments · charged in NGN through Paystack.' : 'Live keys configured; checkout is not currently available.';
  return 'Checkout is disabled until Paystack is configured on the server.';
}

function isCheckoutAvailable() {
  return !!state.billing.workspace?.checkoutAvailable;
}

function clearBillingPollTimer() {
  if (state.billing.pollTimer) {
    clearTimeout(state.billing.pollTimer);
    state.billing.pollTimer = null;
  }
}

function setBillingStickyNotice(type, message) {
  state.billing.stickyNotice = message ? { type, message } : null;
}

function consumeBillingStickyNotice() {
  const notice = state.billing.stickyNotice;
  state.billing.stickyNotice = null;
  return notice;
}

function safeWorkspaceMatches(workspaceId) {
  return !!workspaceId && !!state.activeWorkspaceId && String(workspaceId) === String(state.activeWorkspaceId);
}

function saveBillingReturnFlow(flow) {
  try {
    window.sessionStorage?.setItem(BILLING_RETURN_STORAGE_KEY, JSON.stringify(flow));
  } catch (_) {}
}

function readBillingReturnFlow() {
  try {
    const raw = window.sessionStorage?.getItem(BILLING_RETURN_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function clearBillingReturnFlow() {
  state.billing.returnFlow = null;
  clearBillingPollTimer();
  try {
    window.sessionStorage?.removeItem(BILLING_RETURN_STORAGE_KEY);
  } catch (_) {}
}

async function loadPublicBillingPlan() {
  try {
    const result = await apiCall('GET', '/api/billing/plan');
    state.billing.publicPlan = result || null;
  } catch (_) {
    state.billing.publicPlan = {
      plan: { name: 'Emberstage Pro', amount: 300000, currency: 'NGN', interval: 'monthly', maxDevices: 3, maxDestinations: 3, maxActiveBroadcasts: 1 },
      checkoutAvailable: false,
      checkoutUnavailableReason: 'Billing plan details are not available yet.',
      mode: 'unconfigured'
    };
  }
}

function getWorkspaceEntitlement() {
  const workspaceBilling = state.billing.workspace;
  if (workspaceBilling?.entitlement) return workspaceBilling.entitlement;
  return {
    plan: 'free',
    paidUntil: null,
    cancelAtPeriodEnd: false,
    canStream: false,
    maxDevices: 0,
    maxDestinations: 0,
    maxActiveBroadcasts: 0
  };
}

function getWorkspacePlan() {
  const publicPlan = state.billing.workspace?.plan || state.billing.publicPlan?.plan;
  if (!publicPlan) return { ...FREE_PLAN_FALLBACK };
  return {
    ...FREE_PLAN_FALLBACK,
    ...publicPlan,
    maxDevices: Number(publicPlan.maxDevices ?? FREE_PLAN_FALLBACK.maxDevices),
    maxDestinations: Number(publicPlan.maxDestinations ?? FREE_PLAN_FALLBACK.maxDestinations),
    maxActiveBroadcasts: Number(publicPlan.maxActiveBroadcasts ?? FREE_PLAN_FALLBACK.maxActiveBroadcasts)
  };
}

function getWorkspaceSubscription() {
  return state.billing.workspace?.subscription || {
    status: 'none',
    manageAvailable: false
  };
}

function billingCheckoutReason() {
  const workspaceBilling = state.billing.workspace;
  if (!workspaceBilling) return 'Billing details are still loading.';
  if (workspaceBilling.checkoutAvailable) return '';
  return workspaceBilling.checkoutUnavailableReason || 'Checkout is unavailable right now.';
}

function renderBillingReturnNotice() {
  const flow = state.billing.returnFlow;
  if (!flow || flow.resolved) return '';
  const attemptsRemaining = Math.max(BILLING_POLL_LIMIT - Number(flow.attempts || 0), 0);
  const statusType = flow.lastError ? 'danger' : flow.checking ? 'pending' : 'warning';
  const message = flow.lastError
    ? flow.lastError
    : flow.checking
      ? 'Checking Paystack return with the server before showing success…'
      : attemptsRemaining
        ? 'Payment is still pending verification. You can retry now or wait a moment.'
        : 'Verification stayed pending. Retry manually if Paystack already charged your card.';
  return `
    <div class="billing-return-notice inline-status inline-status-${escapeHtml(statusType)}">
      <div>
        <strong>Billing return</strong>
        <span>${escapeHtml(message)}</span>
      </div>
      <div class="panel-actions panel-actions-wrap">
        <button class="btn btn-secondary" type="button" data-action="billing-manual-retry" ${flow.checking ? 'disabled' : ''}>${flow.checking ? 'Checking…' : 'Retry verification'}</button>
        <button class="btn btn-secondary" type="button" data-action="billing-dismiss-return" ${flow.checking ? 'disabled' : ''}>Dismiss</button>
      </div>
    </div>
  `;
}

async function verifyBillingReturn(options = {}) {
  const flow = state.billing.returnFlow;
  if (!flow || flow.checking || flow.resolved) return;
  if (!safeWorkspaceMatches(flow.workspaceId)) {
    flow.lastError = 'This payment return belongs to a different workspace. Switch to that workspace to verify it.';
    renderSubscriptionPanel();
    return;
  }
  flow.checking = true;
  flow.attempts = Number(flow.attempts || 0) + 1;
  flow.lastError = '';
  saveBillingReturnFlow(flow);
  setStatus('billing', 'pending', 'Checking payment status…');
  renderSubscriptionPanel();
  try {
    const result = await apiCall('POST', `/api/workspaces/${state.activeWorkspaceId}/billing/verify`, { reference: flow.reference });
    if (!safeWorkspaceMatches(flow.workspaceId)) return;
    flow.lastResult = result || null;
    if (result?.verified) {
      flow.resolved = true;
      const active = result.entitlement?.canStream === true;
      const message = active ? 'Payment verified. Pro access is active for this workspace.' : 'Payment verified. Its paid period has ended or access is unavailable; review your subscription.';
      setBillingStickyNotice(active ? 'success' : 'warning', message);
      clearBillingReturnFlow();
      await loadWorkspaceData({ silent: true, force: true });
      setStatus('billing', active ? 'success' : 'warning', message);
      renderSubscriptionPanel();
      return;
    }
    const pendingMessage = result?.message || result?.statusMessage || 'Verification is still pending.';
    if (flow.attempts < BILLING_POLL_LIMIT && !options.manualOnly) {
      setStatus('billing', 'pending', pendingMessage);
      flow.checking = false;
      saveBillingReturnFlow(flow);
      clearBillingPollTimer();
      state.billing.pollTimer = setTimeout(() => verifyBillingReturn(), BILLING_POLL_DELAY_MS);
      renderSubscriptionPanel();
      return;
    }
    flow.lastError = pendingMessage;
    setStatus('billing', 'warning', pendingMessage);
  } catch (error) {
    flow.lastError = apiErrorMessage(error);
    setStatus('billing', 'danger', flow.lastError);
  } finally {
    if (state.billing.returnFlow) {
      state.billing.returnFlow.checking = false;
      saveBillingReturnFlow(state.billing.returnFlow);
    }
    renderSubscriptionPanel();
  }
}

async function resumeBillingReturnFlowIfNeeded() {
  if (state.billing.returnFlow?.resolved) return;
  if (!state.billing.returnFlow) state.billing.returnFlow = readBillingReturnFlow();
  const flow = state.billing.returnFlow;
  if (!flow) return;

  const matchedWorkspace = state.workspaces.find((workspace) => String(workspace.id) === String(flow.workspaceId));
  if (!matchedWorkspace) {
    flow.lastError = 'This payment return is for a workspace you do not belong to.';
    saveBillingReturnFlow(flow);
    renderSubscriptionPanel();
    return;
  }

  if (!safeWorkspaceMatches(flow.workspaceId)) {
    state.activeWorkspaceId = matchedWorkspace.id;
  }

  await loadWorkspaceData({ silent: true, force: true });
  await verifyBillingReturn();
}

function isBusy(key) {
  return !!state.ui.busy[key];
}

function setBusy(key, busy, options = {}) {
  if (busy) state.ui.busy[key] = options.visual === false ? 'silent' : true;
  else delete state.ui.busy[key];
  syncLoader();
}

function foregroundBusy() {
  return Object.values(state.ui.busy).some((value) => value === true) || state.ui.authPending === true;
}

function appViewOpen() {
  const app = document.getElementById('app-view');
  return !!app && app.style.display === 'grid';
}

const STARTUP_CYCLE_MS = 3600;

function startupReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

function beginStartupHold() {
  state.ui.startupHold = !startupReducedMotion();
  state.ui.startupHoldStartedAt = state.ui.startupHold ? Date.now() : 0;
}

function clearStartupHold() {
  state.ui.startupHold = false;
  if (state.ui.startupHoldTimer) {
    clearTimeout(state.ui.startupHoldTimer);
    state.ui.startupHoldTimer = 0;
  }
}

function finishStartupPresentation() {
  if (state.ui.sessionChecking) return;
  if (state.ui.startupHold && !startupReducedMotion()) {
    const started = state.ui.startupHoldStartedAt || 0;
    const wait = Math.max(0, STARTUP_CYCLE_MS - (Date.now() - started));
    if (wait > 0) {
      if (!state.ui.startupHoldTimer) {
        state.ui.startupHoldTimer = setTimeout(() => {
          state.ui.startupHoldTimer = 0;
          state.ui.startupHold = false;
          revealStartupView();
        }, wait);
      }
      syncLoader();
      return;
    }
  }
  clearStartupHold();
  revealStartupView();
}

function overlayStillUp(loadingView) {
  return !!loadingView && loadingView.hidden !== true && loadingView.style.display !== 'none';
}

function revealStartupView() {
  const viewName = state.ui.startupView || (state.user ? 'app' : 'auth');
  const loadingView = document.getElementById('portal-loading');
  const finishReveal = () => {
    if (loadingView) {
      loadingView.hidden = true;
      loadingView.style.display = 'none';
      loadingView.classList.remove('is-fading');
    }
    syncLoader();
  };
  if (overlayStillUp(loadingView)) {
    if (startupReducedMotion()) {
      finishReveal();
    } else if (!loadingView.classList.contains('is-fading')) {
      loadingView.classList.add('is-fading');
      let dropped = false;
      const drop = () => {
        if (dropped) return;
        dropped = true;
        loadingView.removeEventListener('transitionend', onFade);
        finishReveal();
      };
      const onFade = (event) => {
        if (event.target !== loadingView || event.propertyName !== 'opacity') return;
        drop();
      };
      loadingView.addEventListener('transitionend', onFade);
      window.setTimeout(drop, 500);
    }
  }
  if (viewName === 'auth') {
    document.getElementById('auth-view').style.display = 'flex';
    document.getElementById('app-view').style.display = 'none';
    renderAuthView();
  } else {
    document.getElementById('auth-view').style.display = 'none';
    document.getElementById('app-view').style.display = 'grid';
    setActiveView(activeViewFromLocation(), { skipHash: true });
    updateLastSyncLabel();
  }
  window.__emberstageBackdrop?.start();
}

function syncLoader() {
  const loader = document.getElementById('emberstage-loader');
  const park = document.getElementById('emberstage-loader-park');
  const loading = document.getElementById('portal-loading');
  const sessionOn = state.ui.sessionChecking === true || state.ui.startupHold === true;
  const overlayUp = overlayStillUp(loading);
  const pendingOn = !state.ui.sessionChecking && !state.ui.startupHold && !overlayUp && foregroundBusy();
  document.querySelectorAll('[data-loader-slot]').forEach((slot) => {
    slot.hidden = true;
  });
  if (loading && !overlayUp) {
    loading.hidden = !sessionOn;
    loading.style.display = sessionOn ? 'grid' : 'none';
  }
  const slot = (sessionOn || overlayUp)
    ? document.getElementById('portal-loading-slot')
    : pendingOn
      ? document.getElementById(appViewOpen() ? 'app-pending-slot' : 'auth-pending-slot')
      : null;
  if (!loader || !park) return;
  if (!slot) {
    loader.hidden = true;
    if (loader.parentElement !== park) park.appendChild(loader);
    setLoaderBusy(false);
    return;
  }
  slot.hidden = false;
  if (loader.parentElement !== slot) slot.appendChild(loader);
  loader.hidden = false;
  setLoaderBusy(true);
}

const abortControllers = new Set();

function trackAbort() {
  const controller = new AbortController();
  abortControllers.add(controller);
  controller.signal.addEventListener('abort', () => abortControllers.delete(controller), { once: true });
  return controller;
}

function releaseAbort(controller) {
  abortControllers.delete(controller);
}

function abortTracked() {
  for (const controller of Array.from(abortControllers)) controller.abort();
}

function setLoaderBusy(on) {
  const region = document.getElementById(appViewOpen() ? 'app-view' : 'auth-view');
  if (region) {
    if (on) region.setAttribute('aria-busy', 'true');
    else region.removeAttribute('aria-busy');
  }
  const container = document.getElementById('app-container');
  if (container && state.ui.sessionChecking) container.setAttribute('aria-busy', 'true');
  else if (container) container.removeAttribute('aria-busy');
}

function setStatus(key, type, message) {
  state.ui.statuses[key] = { type, message };
}

function clearStatus(key) {
  delete state.ui.statuses[key];
}

function renderStatus(key) {
  const status = state.ui.statuses[key];
  if (!status?.message) return '';
  return `<div class="inline-status inline-status-${escapeHtml(status.type)}">${escapeHtml(status.message)}</div>`;
}

function apiErrorMessage(error) {
  return error?.message || 'Something went wrong.';
}

async function apiCall(method, path, body = null, options = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';

  const csrfToken = getCookie('_csrf');
  if (csrfToken && ['POST', 'PUT', 'DELETE'].includes(method.toUpperCase())) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  const response = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: options.signal
  });

  if (response.status === 401 && !path.includes('/api/auth/login') && !path.includes('/api/auth/register')) {
    state.user = null;
    showView('auth');
    return null;
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || 'API request failed');
  }
  return data;
}

function showView(viewName) {
  state.ui.startupView = viewName;
  state.ui.sessionChecking = false;
  if (state.ui.startupHold) {
    finishStartupPresentation();
    return;
  }
  if (viewName === 'auth') {
    document.getElementById('auth-view').style.display = 'flex';
    document.getElementById('app-view').style.display = 'none';
    renderAuthView();
    syncLoader();
    return;
  }
  document.getElementById('auth-view').style.display = 'none';
  document.getElementById('app-view').style.display = 'grid';
  setActiveView(activeViewFromLocation(), { skipHash: true });
  updateLastSyncLabel();
  syncLoader();
}

function showAlert(message, type = 'danger') {
  const alertEl = document.getElementById('app-alert');
  alertEl.textContent = message;
  alertEl.className = `alert alert-${type}`;
  alertEl.style.display = 'block';
}

function hideAlert() {
  const alertEl = document.getElementById('app-alert');
  alertEl.style.display = 'none';
  alertEl.textContent = '';
}

function currentBillingReferenceFromLocation() {
  const params = new URLSearchParams(window.location?.search || '');
  const status = String(params.get('billing') || '').toLowerCase();
  const workspaceId = params.get('workspaceId') || '';
  const reference = params.get('reference') || params.get('trxref') || '';
  if (status !== 'return' || !workspaceId || !reference) return null;
  return { workspaceId, reference, status: 'return' };
}

function clearBillingReturnQuery() {
  if (!window.history?.replaceState || !window.location) return;
  const url = new URL(window.location.href);
  url.searchParams.delete('billing');
  url.searchParams.delete('workspaceId');
  url.searchParams.delete('reference');
  url.searchParams.delete('trxref');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash || '#workspace'}`);
}

function primeBillingReturnFlowFromLocation() {
  const incoming = currentBillingReferenceFromLocation();
  if (!incoming) return;
  state.billing.returnFlow = {
    workspaceId: incoming.workspaceId,
    reference: incoming.reference,
    attempts: 0,
    checking: false,
    resolved: false,
    lastResult: null,
    lastError: ''
  };
  saveBillingReturnFlow(state.billing.returnFlow);
  clearBillingReturnQuery();
}

function renderAuthView() {
  const workspaceGroup = document.getElementById('workspace-group');
  const modeLabel = document.getElementById('auth-mode-label');
  const authTitle = document.getElementById('auth-title');
  const authSubcopy = document.getElementById('auth-subcopy');
  const submitBtn = document.getElementById('auth-submit-btn');
  const toggleCopy = document.getElementById('auth-toggle-copy');
  const toggleLink = document.getElementById('auth-toggle-link');

  if (state.isRegisterMode) {
    workspaceGroup.style.display = 'block';
    modeLabel.textContent = 'Register';
    authTitle.textContent = 'Create your workspace';
    authSubcopy.textContent = 'Create the workspace this account will manage.';
    submitBtn.textContent = 'Create workspace';
    toggleCopy.textContent = 'Already have an account?';
    toggleLink.textContent = 'Sign in instead';
  } else {
    workspaceGroup.style.display = 'none';
    modeLabel.textContent = 'Sign in';
    authTitle.textContent = 'Welcome back';
    authSubcopy.textContent = 'Sign in to manage your workspace.';
    submitBtn.textContent = 'Sign In';
    toggleCopy.textContent = 'Need an account?';
    toggleLink.textContent = 'Create an account';
  }

  updateAuthMethodsVisibility();
}

function updateAuthMethodsVisibility() {
  const methods = document.getElementById('auth-methods');
  const divider = document.getElementById('auth-divider');
  const oauthButtons = [
    document.getElementById('auth0-auth-button'),
    document.getElementById('google-auth-button')
  ].filter(Boolean);

  const visibleButtons = oauthButtons.filter((button) => !button.hidden && button.style.display !== 'none');
  const hasVisibleOauth = visibleButtons.length > 0;

  if (methods) methods.hidden = !hasVisibleOauth;
  if (divider) divider.hidden = !hasVisibleOauth;
}

function normalizeViewName(viewName) {
  return PORTAL_VIEWS[viewName] ? viewName : 'overview';
}

function currentViewName() {
  return normalizeViewName(state.ui.activeView);
}

function setActiveView(viewName, options = {}) {
  const nextView = normalizeViewName(viewName);
  state.ui.activeView = nextView;

  const titleEl = document.getElementById('view-title');
  const subtitleEl = document.getElementById('view-subtitle');
  const viewMeta = PORTAL_VIEWS[nextView];
  if (titleEl) titleEl.textContent = viewMeta.title;
  if (subtitleEl) subtitleEl.textContent = viewMeta.subtitle;

  document.querySelectorAll?.('.portal-view').forEach((section) => {
    const active = section.dataset.view === nextView;
    section.hidden = !active;
  });

  document.querySelectorAll?.('[data-action="open-view"]').forEach((button) => {
    const active = button.dataset.view === nextView;
    button.classList.toggle('nav-link-active', active);
    button.classList.toggle('mobile-nav-link-active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });

  if (!options.skipHash && window.location) {
    window.location.hash = `#${nextView}`;
  }
}

function activeViewFromLocation() {
  const hash = String(window.location?.hash || '').replace(/^#/, '');
  return normalizeViewName(hash || state.ui.activeView);
}

function updateLastSyncLabel() {
  const label = document.getElementById('last-sync-label');
  if (!label) return;
  label.textContent = state.ui.lastLoadedAt
    ? `Last sync: ${formatRelativeTime(state.ui.lastLoadedAt)}`
    : 'Last sync: waiting';
}

function isSetupLocked() {
  return !!state.setup?.stream;
}

function currentStreamStatus() {
  return state.setup?.stream?.status || null;
}

function currentStreamDeviceId() {
  return state.setup?.stream?.device_id || '';
}

function selectedDevice() {
  return (state.setup.devices || []).find((device) => device.id === state.selectedDeviceId) || null;
}

function allDestinations() {
  return Array.isArray(state.setup?.destinations) ? state.setup.destinations : [];
}

function selectedDestinations() {
  return allDestinations().filter((destination) => destination.selected);
}

function youtubeTargets() {
  return state.providerTargets.filter((target) => target.provider === 'youtube');
}

function selectedYoutubeTarget() {
  return youtubeTargets().find((target) => target.id === state.selectedYoutubeTargetId) || null;
}

function findDestinationById(id) {
  return allDestinations().find((destination) => destination.id === id) || null;
}

function getSelectedBroadcastForTarget(targetId) {
  const selectedId = state.youtubeBroadcastSelections[targetId];
  if (selectedId) {
    const list = state.youtubeBroadcasts[targetId] || [];
    const found = list.find((broadcast) => broadcast.id === selectedId);
    if (found) return found;

    const destination = findDestinationById(targetId);
    if (destination?.broadcast?.id === selectedId) return destination.broadcast;

    return { id: selectedId, title: 'Selected Broadcast' };
  }

  const destination = findDestinationById(targetId);
  if (destination?.broadcast?.id) return destination.broadcast;

  return null;
}

function selectedYoutubeBroadcast() {
  return getSelectedBroadcastForTarget(state.selectedYoutubeTargetId);
}

function hydrateDraftsFromBroadcast(broadcast) {
  if (!broadcast) return;
  state.drafts.youtubeUpdate = {
    title: broadcast.title || '',
    description: broadcast.description || '',
    privacyStatus: String(broadcast.privacyStatus || 'private').toLowerCase(),
    latencyPreference: broadcast.latencyPreference || 'normal',
    categoryId: broadcast.categoryId || ''
  };
}

function reconcileSelections() {
  const devices = state.setup.devices || [];
  const streamDeviceId = currentStreamDeviceId();
  if (streamDeviceId && devices.some((device) => device.id === streamDeviceId)) {
    state.selectedDeviceId = streamDeviceId;
  } else if (!state.selectedDeviceId || !devices.some((device) => device.id === state.selectedDeviceId)) {
    const next = devices.find((device) => device.status === 'active') || devices[0];
    state.selectedDeviceId = next?.id || '';
  }

  const ytTargets = youtubeTargets();
  if (!ytTargets.some((target) => target.id === state.selectedYoutubeTargetId)) {
    state.selectedYoutubeTargetId = ytTargets[0]?.id || '';
  }

  ytTargets.forEach((target) => {
    const destination = findDestinationById(target.id);
    if (destination?.broadcast?.id) {
      state.youtubeBroadcastSelections[target.id] = destination.broadcast.id;
    }
  });

  if (!state.drafts.youtubeBulk.targetIds.length) {
    state.drafts.youtubeBulk.targetIds = selectedDestinations()
      .filter((destination) => destination.provider === 'youtube')
      .map((destination) => destination.id);
  } else {
    state.drafts.youtubeBulk.targetIds = state.drafts.youtubeBulk.targetIds.filter((id) => ytTargets.some((target) => target.id === id));
  }

  const selected = selectedYoutubeBroadcast();
  if (selected) hydrateDraftsFromBroadcast(selected);
}

async function configureProductAuth() {
  const auth0Button = document.getElementById('auth0-auth-button');
  const googleButton = document.getElementById('google-auth-button');
  if (googleButton) {
    googleButton.hidden = true;
    googleButton.style.display = 'none';
  }

  try {
    const response = await fetch('/api/auth/config', { headers: { Accept: 'application/json' } });
    const authConfig = await response.json();
    if (auth0Button) {
      auth0Button.hidden = !authConfig?.auth0?.enabled;
      auth0Button.style.display = authConfig?.auth0?.enabled ? '' : 'none';
      if (!auth0Button.hidden && !auth0Button.dataset.ready) {
        auth0Button.dataset.ready = 'true';
        auth0Button.addEventListener('click', () => {
          window.location.href = '/api/auth/auth0/start';
        });
      }
    }
  } catch (_) {
    if (auth0Button) {
      auth0Button.hidden = true;
      auth0Button.style.display = 'none';
    }
  } finally {
    updateAuthMethodsVisibility();
  }
}

let workspaceDataLoad = null;

function loadWorkspaceData(options = {}) {
  const workspaceId = state.activeWorkspaceId;
  if (!workspaceId) return Promise.resolve();
  if (!options.force && workspaceDataLoad?.workspaceId === workspaceId) return workspaceDataLoad.promise;
  const load = { workspaceId };
  load.promise = fetchWorkspaceData(options, workspaceId).finally(() => {
    if (workspaceDataLoad === load) workspaceDataLoad = null;
  });
  workspaceDataLoad = load;
  return load.promise;
}

async function fetchWorkspaceData(options, workspaceId) {
  if (!state.activeWorkspaceId) return;
  try {
    const [workspaceResult, setupResult, providersResult, targetsResult, customTargetsResult, billingResult] = await Promise.all([
      apiCall('GET', `/api/workspaces/${state.activeWorkspaceId}`),
      apiCall('GET', `/api/workspaces/${state.activeWorkspaceId}/streams/setup`),
      apiCall('GET', `/api/workspaces/${state.activeWorkspaceId}/providers`),
      apiCall('GET', `/api/workspaces/${state.activeWorkspaceId}/providers/targets`),
      apiCall('GET', `/api/workspaces/${state.activeWorkspaceId}/streams/custom-targets`),
      apiCall('GET', `/api/workspaces/${state.activeWorkspaceId}/billing`)
    ]);

    if (state.activeWorkspaceId !== workspaceId || !state.user) return;
    if (workspaceResult?.success) {
      state.activeWorkspace = workspaceResult.workspace;
      state.activeWorkspaceRole = workspaceResult.role || state.activeWorkspaceRole;
    }
    state.setup = setupResult || { ingestServer: '', devices: [], stream: null, destinations: [] };
    state.providers = providersResult?.providers || {};
    state.providerTargets = Array.isArray(targetsResult) ? targetsResult : [];
    state.customTargets = customTargetsResult?.targets || [];
    state.billing.workspace = billingResult || null;
    state.billing.summaryError = '';

    document.getElementById('header-workspace-name').textContent = state.activeWorkspace?.name || 'Workspace';
    document.getElementById('header-user-email').textContent = state.user?.email || '—';
    document.getElementById('header-user-role').textContent = roleLabel(state.activeWorkspaceRole);
    document.getElementById('header-workspace-plan').textContent = getWorkspaceEntitlement().plan === 'pro'
      ? `${getWorkspacePlan().name || 'Emberstage Pro'} · ${formatPlanPrice(getWorkspacePlan())}`
      : 'Free';

    reconcileSelections();
    renderApp();
    state.ui.lastLoadedAt = new Date().toISOString();
    updateLastSyncLabel();

    if (state.selectedYoutubeTargetId) {
      await ensureYoutubeBroadcasts(state.selectedYoutubeTargetId, { silent: true });
    }
  } catch (error) {
    state.billing.summaryError = apiErrorMessage(error);
    if (!options.silent) showAlert(`Error loading workspace details: ${apiErrorMessage(error)}`);
  }
}

function statusChip(label, tone) {
  return `<span class="status-chip status-chip-${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function meterPill(label, tone) {
  return `<span class="meter-pill meter-pill-${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function providerReceivingPill(destination) {
  if (destination?.provider === 'youtube') {
    const receiving = destination?.delivery?.streamStatus || 'unknown';
    return meterPill(`Receiving ${titleCase(receiving)}`, toneForReceiving(receiving));
  }
  return meterPill('Provider state via platform', 'muted');
}

function providerLivePill(destination) {
  if (destination?.provider === 'youtube') {
    const live = destination?.delivery?.broadcastStatus || 'unknown';
    return meterPill(`Live ${titleCase(live)}`, toneForBroadcast(live));
  }
  return meterPill('Public live state via platform', 'muted');
}

function toneForRelay(value) {
  if (value === 'relaying') return 'success';
  if (value === 'starting') return 'warning';
  if (value === 'stalled' || value === 'failed') return 'danger';
  if (value === 'stopped') return 'muted';
  return 'muted';
}

function toneForReceiving(value) {
  if (value === 'active') return 'success';
  if (value === 'created' || value === 'ready') return 'warning';
  if (value === 'error' || value === 'inactive') return 'danger';
  return 'muted';
}

function toneForBroadcast(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'live' || normalized === 'livestarting') return 'danger';
  if (normalized === 'ready' || normalized === 'teststarting' || normalized === 'testing') return 'warning';
  if (normalized === 'complete' || normalized === 'completed') return 'muted';
  return 'muted';
}

function sessionLockCopy() {
  if (!isSetupLocked()) return '';
  return `<div class="lock-note">Setup-changing actions are locked while the current OBS session is ${escapeHtml(currentStreamStatus())}. End broadcast stays available below, but normal YouTube auto-go-live approval happens before OBS starts.</div>`;
}

function deviceHasKey(device) {
  return !!device?.ingest_key_last4;
}

function renderCommandStage() {
  const stream = state.setup.stream;
  const selected = selectedDestinations();
  const youtubeSelected = selected.filter((destination) => destination.provider === 'youtube');
  const live = youtubeSelected.filter((destination) => String(destination.delivery?.broadcastStatus || '').toLowerCase() === 'live').length;

  const cards = [
    stream?.status === 'streaming'
      ? { title: 'OBS Studio', value: 'Live signal detected', tone: 'danger', copy: stream.started_at ? `Started ${formatDateTime(stream.started_at)}` : 'Encoder is sending video now.' }
      : stream?.status === 'reserved'
        ? { title: 'OBS Studio', value: 'Session reserved', tone: 'warning', copy: 'Waiting for ingest bytes.' }
        : { title: 'OBS Studio', value: 'Offline', tone: 'muted', copy: 'No signal' },
    selected.some((destination) => destination.delivery?.relayState === 'relaying')
      ? { title: 'Ember Relay', value: 'Relaying', tone: 'success', copy: 'Bytes are leaving the local relay.' }
      : selected.length
        ? { title: 'Ember Relay', value: 'Standby ready', tone: 'warning', copy: `${selected.length} destination${selected.length === 1 ? '' : 's'} approved.` }
        : { title: 'Ember Relay', value: 'Idle', tone: 'muted', copy: 'No approved destinations yet.' },
    selected.length
      ? { title: 'Destinations', value: live ? `${live} live destination${live === 1 ? '' : 's'}` : 'Waiting for signal', tone: live ? 'danger' : 'muted', copy: `${selected.length} configured` }
      : { title: 'Destinations', value: 'No destinations approved', tone: 'muted', copy: '0 configured' },
    youtubeSelected.length
      ? { title: 'Audience live', value: live ? 'Provider marked live' : 'Not live yet', tone: live ? 'danger' : 'warning', copy: live ? 'Live state is separate from privacy and relay readiness.' : 'Provider live stays separate from relay state.' }
      : { title: 'Audience live', value: 'No broadcast approved', tone: 'muted', copy: 'Choose a YouTube broadcast first.' }
  ];

  const sessionTone = live
    ? 'danger'
    : stream?.status === 'streaming'
      ? 'warning'
      : selected.length
        ? 'warning'
        : 'muted';
  const sessionLabel = live
    ? 'System live'
    : stream?.status === 'streaming'
      ? 'Ingest active'
      : 'System idle';

  const chip = document.getElementById('active-session-chip');
  chip.className = `status-chip status-chip-${sessionTone}`;
  chip.textContent = sessionLabel;

  document.getElementById('command-stage-grid').innerHTML = cards.map((card) => `
    <article class="stage-card stage-card-${escapeHtml(card.tone)}">
      <div class="stage-topline">
        <span class="stage-dot stage-dot-${escapeHtml(card.tone)}"></span>
        <p class="stage-label">${escapeHtml(card.title)}</p>
      </div>
      <h3>${escapeHtml(card.value)}</h3>
      <p>${escapeHtml(card.copy)}</p>
    </article>
  `).join('');
}

function renderEncoderPanel() {
  const container = document.getElementById('encoder-panel');
  const device = selectedDevice();
  const locked = isSetupLocked();
  const activeKey = state.ingestCredentials && state.ingestCredentials.deviceId === device?.id ? state.ingestCredentials : null;
  const deviceOptions = (state.setup.devices || []).map((entry) => `
    <option value="${escapeHtml(entry.id)}" ${entry.id === state.selectedDeviceId ? 'selected' : ''}>${escapeHtml(entry.name)}${entry.id === currentStreamDeviceId() ? ' · active session' : ''}</option>
  `).join('');
  const latestSession = device?.latestSession
    ? `${titleCase(device.latestSession.status)}${device.latestSession.started_at ? ` · ${formatDateTime(device.latestSession.started_at)}` : ''}`
    : 'No stream session recorded yet.';

  container.innerHTML = `
    <div class="panel-stack">
      ${renderStatus('encoder')}
      ${sessionLockCopy()}
      <article class="rail-card rail-card-device">
        <div class="rail-row rail-row-between">
          <div>
            <p class="field-label">Selected device</p>
            <h3>${device ? escapeHtml(device.name) : 'No device selected'}</h3>
            <p class="section-copy">${escapeHtml(device ? latestSession : 'Pair a device first to unlock OBS setup.')}</p>
          </div>
          ${device ? statusChip(titleCase(device.status || 'unknown'), device.status === 'active' ? 'success' : device.status === 'pending' ? 'warning' : 'muted') : statusChip('Waiting', 'muted')}
        </div>
        ${(state.setup.devices || []).length ? `
          <label class="select-shell">
            <span class="sr-only">Choose device</span>
            <select id="encoder-device-select" ${locked ? 'disabled' : ''}>${deviceOptions}</select>
          </label>
        ` : '<div class="empty-inline">Pair a device first to generate a reusable OBS setup.</div>'}
      </article>
      <article class="rail-card">
        <p class="field-label">RTMP ingest server</p>
        <div class="mono-value">${escapeHtml(state.setup.ingestServer || 'Not configured')}</div>
        <p class="meta-copy">Every OBS device points at the same local Emberstage ingest.</p>
        <div class="panel-actions">
          <button class="btn btn-secondary btn-block" type="button" data-action="copy-ingest-server" ${state.setup.ingestServer ? '' : 'disabled'}>Copy RTMP URL</button>
        </div>
      </article>
      <article class="key-card ${activeKey ? 'key-card-fresh' : ''}">
        <div class="section-head section-head-tight">
          <div>
            <p class="field-label">Stream key</p>
            <h3>${device ? escapeHtml(device.name) : 'No device selected'}</h3>
          </div>
          ${device && deviceHasKey(device) ? statusChip(`Stored as ••••${device.ingest_key_last4}`, 'warning') : statusChip('Not set yet', 'muted')}
        </div>
        ${device ? `
          <p class="section-copy">${activeKey
            ? 'This new OBS key is shown one time only.'
            : deviceHasKey(device)
              ? `The current OBS key ends in ••••${escapeHtml(device.ingest_key_last4)}.`
              : 'Generate the reusable OBS key once for this device.'}
          </p>
          <div class="secret-row">
            <div class="secret-value">${activeKey ? escapeHtml(activeKey.revealed ? activeKey.streamKey : maskSecret(activeKey.streamKey)) : escapeHtml(deviceHasKey(device) ? `Stored key ending ••••${device.ingest_key_last4}` : 'No OBS stream key generated yet')}</div>
            <div class="panel-actions panel-actions-wrap">
              ${activeKey ? `<button class="btn btn-secondary" type="button" data-action="toggle-new-key-visibility">${activeKey.revealed ? 'Hide key' : 'Reveal key'}</button>` : ''}
              ${activeKey ? '<button class="btn btn-secondary" type="button" data-action="copy-new-key">Copy key</button>' : ''}
              <button class="btn" type="button" data-action="rotate-ingest-key" data-device-id="${escapeHtml(device.id)}" ${device.status !== 'active' || locked || isBusy(`rotate-device-${device.id}`) ? 'disabled' : ''}>${isBusy(`rotate-device-${device.id}`) ? 'Working…' : deviceHasKey(device) ? 'Rotate key' : 'Set up OBS'}</button>
              ${activeKey ? '<button class="btn btn-secondary" type="button" data-action="dismiss-new-key">Dismiss</button>' : ''}
            </div>
          </div>
          <details class="portal-details">
            <summary>More setup details</summary>
            <div class="portal-details-body meta-grid meta-grid-2">
              <div class="meta-card">
                <span>Current device state</span>
                <strong>${escapeHtml(titleCase(device.status || 'unknown'))}</strong>
              </div>
              <div class="meta-card">
                <span>Latest key rotation</span>
                <strong>${device.ingest_key_rotated_at ? escapeHtml(formatDateTime(device.ingest_key_rotated_at)) : 'Never'}</strong>
              </div>
            </div>
          </details>
        ` : '<div class="empty-inline">Pick a paired device to manage its OBS setup.</div>'}
      </article>
      <article class="rail-card rail-card-tip">
        <p class="field-label">Start sequence</p>
        <p class="section-copy">Once OBS starts streaming, Emberstage relays to every enabled destination and approved broadcast automatically.</p>
      </article>
    </div>
  `;
}

function renderProviderTargetRow(target) {
  const destination = findDestinationById(target.id);
  const relay = destination?.delivery?.relayState || 'unknown';
  const broadcast = destination?.broadcast;
  const summary = destination?.detail || 'Connected and ready to be enabled.';
  const isFacebookProfile = target.provider === 'facebook' && /personal profile/i.test(target.name || '');
  const facebookPrivacyNote = isFacebookProfile && !/only me|private|friends|public/i.test(summary)
    ? 'Personal Profile broadcasts default to Only Me until Facebook privacy is changed there.'
    : '';
  return `
    <article class="destination-toggle-row ${target.selected ? 'destination-toggle-row-selected' : ''}">
      <div class="destination-row-head">
        <div class="destination-toggle-main">
          <div class="provider-badge provider-badge-${escapeHtml(target.provider)}" aria-hidden="true">${escapeHtml(target.provider.slice(0, 1).toUpperCase())}</div>
          <div class="destination-toggle-copy">
            <div class="destination-title-row">
              <strong>${escapeHtml(target.name)}</strong>
              ${statusChip(target.selected ? 'Enabled' : 'Disabled', target.selected ? 'success' : 'muted')}
            </div>
            <div class="destination-row-copy">${escapeHtml(summary)}</div>
            <div class="destination-row-extra destination-approval-copy">${target.selected ? 'Approved for auto-go-live when OBS starts streaming.' : 'Disabled channels stay connected but out of the live path.'}</div>
            ${facebookPrivacyNote ? `<div class="destination-row-extra">${escapeHtml(facebookPrivacyNote)}</div>` : ''}
          </div>
        </div>
        <div class="destination-row-controls">
          <label class="toggle-switch">
            <input type="checkbox" data-action="toggle-provider-target" data-target-id="${escapeHtml(target.id)}" ${target.selected ? 'checked' : ''} ${isSetupLocked() || isBusy(`toggle-target-${target.id}`) ? 'disabled' : ''}>
            <span class="toggle-switch-ui" aria-hidden="true"></span>
            <span class="sr-only">Toggle ${escapeHtml(target.name)}</span>
          </label>
        </div>
      </div>
      <div class="delivery-pill-set delivery-pill-set-wrap delivery-pill-set-compact">
        ${meterPill(`Relay ${titleCase(relay)}`, toneForRelay(relay))}
        ${providerReceivingPill(destination)}
        ${providerLivePill(destination)}
      </div>
      <div class="destination-row-actions">
        ${target.provider === 'youtube' ? `<button class="btn btn-secondary btn-compact" type="button" data-action="open-view" data-view="broadcasts">${broadcast ? 'Open broadcasts' : 'Configure broadcast'}</button>` : ''}
        ${broadcast ? `<details class="portal-details portal-details-inline"><summary>Details</summary><div class="portal-details-body">Broadcast: <strong>${escapeHtml(broadcast.title || 'Untitled')}</strong> · ${escapeHtml(titleCase(broadcast.lifeCycleStatus || 'ready'))}</div></details>` : ''}
      </div>
    </article>
  `;
}

function renderProviderCard(provider) {
  const details = state.providers[provider] || {};
  const targets = state.providerTargets.filter((target) => target.provider === provider);
  const statusLabel = details.connected ? 'Connected' : (details.connect_available ? 'Disconnected' : 'Unavailable');
  const statusTone = details.connected ? 'success' : (details.connect_available ? 'warning' : 'muted');
  const unavailableCopy = details.reason || 'OAuth is not configured.';
  return `
    <article class="provider-surface">
      <div class="section-head section-head-tight">
        <div>
          <h3>${escapeHtml(titleCase(provider))}</h3>
          <p class="section-copy">${details.connected ? `${targets.length} destination${targets.length === 1 ? '' : 's'} connected` : details.connect_available ? 'Not connected.' : escapeHtml(unavailableCopy)}</p>
        </div>
        ${statusChip(statusLabel, statusTone)}
      </div>
      <div class="panel-actions provider-action-row">
        ${details.connected
          ? `<button class="btn btn-secondary" type="button" data-action="disconnect-provider" data-provider="${escapeHtml(provider)}" ${isSetupLocked() || isBusy(`provider-disconnect-${provider}`) ? 'disabled' : ''}>${isBusy(`provider-disconnect-${provider}`) ? 'Disconnecting…' : 'Disconnect'}</button>`
          : `<button class="btn" type="button" data-action="connect-provider" data-provider="${escapeHtml(provider)}" ${!details.connect_available || isSetupLocked() || isBusy(`provider-connect-${provider}`) ? 'disabled' : ''}>${isBusy(`provider-connect-${provider}`) ? 'Opening…' : 'Connect'}</button>`}
      </div>
      ${details.reason && !details.connected ? `<div class="provider-note">${escapeHtml(details.reason)}</div>` : ''}
      ${renderStatus(`provider-${provider}`)}
      ${!details.connected && state.ui.statuses[`provider-${provider}`]?.connectUrl ? `<a class="btn btn-secondary" href="${escapeHtml(state.ui.statuses[`provider-${provider}`].connectUrl)}" target="_blank" rel="noopener noreferrer">Continue ${escapeHtml(titleCase(provider))} sign-in</a>` : ''}
    </article>
  `;
}

function renderCustomTargets() {
  return `
    <article class="provider-surface provider-surface-wide">
      <div class="section-head section-head-tight">
        <div>
          <h3>Custom destinations</h3>
        </div>
        ${statusChip(`${state.customTargets.length} configured`, state.customTargets.length ? 'warning' : 'muted')}
      </div>
      ${renderStatus('custom-targets')}
      <details class="portal-details">
        <summary>Add custom RTMP destination</summary>
        <form id="custom-target-form" class="dense-form portal-details-body">
          <div class="field-grid field-grid-3">
            <label class="field-shell">
              <span>Name</span>
              <input class="form-control" type="text" name="name" data-draft-section="customTarget" value="${escapeHtml(state.drafts.customTarget.name)}" placeholder="Sanctuary feed">
            </label>
            <label class="field-shell">
              <span>RTMP URL</span>
              <input class="form-control" type="url" name="stream_url" data-draft-section="customTarget" value="${escapeHtml(state.drafts.customTarget.stream_url)}" placeholder="rtmps://live.example.com/app">
            </label>
            <label class="field-shell">
              <span>Stream key</span>
              <input class="form-control" type="password" name="stream_key" data-draft-section="customTarget" value="${escapeHtml(state.drafts.customTarget.stream_key)}" placeholder="Paste key">
            </label>
          </div>
          <div class="panel-actions">
            <button class="btn" type="submit" ${isSetupLocked() || isBusy('create-custom-target') ? 'disabled' : ''}>${isBusy('create-custom-target') ? 'Adding…' : 'Add custom RTMP target'}</button>
          </div>
        </form>
      </details>
      <div class="destination-board compact-board">
        ${state.customTargets.length ? state.customTargets.map((target) => {
          const destination = findDestinationById(target.id);
          const relay = destination?.delivery?.relayState || 'unknown';
          return `
            <div class="destination-board-row">
              <div class="destination-board-main">
                <label class="checkbox-line">
                  <input type="checkbox" data-action="toggle-custom-target" data-target-id="${escapeHtml(target.id)}" ${target.selected ? 'checked' : ''} ${isSetupLocked() || isBusy(`toggle-target-${target.id}`) ? 'disabled' : ''}>
                  <span>${escapeHtml(target.name)}</span>
                </label>
                <div class="destination-row-copy">${escapeHtml(destination?.detail || 'Ready to relay through Emberstage.')}</div>
              </div>
              <div class="destination-board-side">
                ${meterPill(`Relay ${titleCase(relay)}`, toneForRelay(relay))}
                <button class="btn btn-secondary btn-compact" type="button" data-action="delete-custom-target" data-target-id="${escapeHtml(target.id)}" ${isSetupLocked() || isBusy(`delete-custom-target-${target.id}`) ? 'disabled' : ''}>Delete</button>
              </div>
            </div>
          `;
        }).join('') : ''}
      </div>
    </article>
  `;
}

function renderDestinationBoard() {
  const destinations = allDestinations();
  if (!destinations.length) {
    return '<div class="empty-state-inline">No destinations connected yet. Connect a provider or add a custom RTMP target.</div>';
  }
  return `
    <div class="destination-board">
      ${destinations.map((destination) => {
        const relay = destination.delivery?.relayState || 'unknown';
        return `
          <article class="destination-panel ${destination.selected ? 'destination-panel-selected' : ''}">
            <div class="section-head section-head-tight">
              <div>
                <p class="field-label">${escapeHtml(destination.provider || destination.type)}</p>
                <h3>${escapeHtml(destination.name)}</h3>
              </div>
              ${statusChip(destination.selected ? 'Approved' : 'Ignored', destination.selected ? 'success' : 'muted')}
            </div>
            <p class="section-copy">${escapeHtml(destination.detail || 'No extra status available.')}</p>
            <div class="destination-row-extra">${destination.selected ? 'Enabled here means approved to join automatically when OBS starts.' : 'Disabled, disconnected, or unapproved channels stay out of the auto-go-live path.'}</div>
            ${destination.broadcast ? `<div class="destination-broadcast">Broadcast: <strong>${escapeHtml(destination.broadcast.title || 'Untitled')}</strong> · ${escapeHtml(titleCase(destination.broadcast.lifeCycleStatus || 'ready'))}</div>` : ''}
            <div class="delivery-pill-set delivery-pill-set-wrap">
              ${meterPill(`Relay ${titleCase(relay)}`, toneForRelay(relay))}
              ${providerReceivingPill(destination)}
              ${providerLivePill(destination)}
            </div>
            ${destination.delivery?.lastProgressAt ? `<div class="destination-row-extra">Last relay progress ${escapeHtml(formatRelativeTime(destination.delivery.lastProgressAt))}</div>` : ''}
          </article>
        `;
      }).join('')}
    </div>
  `;
}

function renderChannelsPanel() {
  document.getElementById('channels-panel').innerHTML = `
    <div class="panel-stack channels-panel-shell">
      ${renderStatus('channels')}
      ${sessionLockCopy()}
      <div class="overview-copy-row">
        <span class="overview-summary">Enabled destinations go live when OBS starts.</span>
        <span class="overview-summary">${selectedDestinations().length ? `${selectedDestinations().length} enabled` : 'No destinations enabled yet'}</span>
      </div>
      <div class="provider-target-list destination-list">
        ${state.providerTargets.length ? state.providerTargets.map((target) => renderProviderTargetRow(target)).join('') : '<div class="empty-state-inline">No destinations connected. Provider sign-in stays unavailable until it is configured.</div>'}
      </div>
      <details class="portal-details connections-details" ${state.providerTargets.length ? '' : 'open'}>
        <summary>Connect or manage accounts</summary>
        <div class="provider-surface-grid portal-details-body">
          ${PROVIDERS.map((provider) => renderProviderCard(provider)).join('')}
        </div>
      </details>
      ${renderCustomTargets()}
    </div>
  `;
}

function renderBroadcastList(targetId, broadcasts, selectedId) {
  if (!broadcasts.length) {
    return '<div class="empty-inline">No broadcasts loaded yet for this YouTube channel.</div>';
  }
  return broadcasts.map((broadcast) => `
    <label class="broadcast-row ${broadcast.id === selectedId ? 'broadcast-row-selected' : ''}">
      <div class="broadcast-row-main">
        <input type="radio" name="selected-broadcast" value="${escapeHtml(broadcast.id)}" data-action="pick-broadcast-radio" ${broadcast.id === selectedId ? 'checked' : ''}>
        <div>
          <strong>${escapeHtml(broadcast.title || 'Untitled broadcast')}</strong>
          <div class="destination-row-copy">${escapeHtml(broadcast.description || 'No description')}</div>
          <div class="destination-row-extra">${escapeHtml(titleCase(broadcast.lifeCycleStatus || 'ready'))} · ${escapeHtml(titleCase(broadcast.privacyStatus || 'private'))}${broadcast.scheduledStartTime ? ` · ${escapeHtml(formatDateTime(broadcast.scheduledStartTime))}` : ''}</div>
        </div>
      </div>
      <button class="btn btn-secondary btn-compact" type="button" data-action="select-broadcast" data-target-id="${escapeHtml(targetId)}" data-broadcast-id="${escapeHtml(broadcast.id)}" ${isSetupLocked() || isBusy(`select-broadcast-${targetId}`) ? 'disabled' : ''}>${broadcast.id === selectedId ? 'Selected' : 'Use this'}</button>
    </label>
  `).join('');
}

function renderYouTubeStudio() {
  const container = document.getElementById('youtube-studio-panel');
  const targets = youtubeTargets();
  const target = selectedYoutubeTarget();
  const broadcasts = target ? (state.youtubeBroadcasts[target.id] || []) : [];
  const selectedId = target ? (state.youtubeBroadcastSelections[target.id] || getSelectedBroadcastForTarget(target.id)?.id || '') : '';
  const currentBroadcast = selectedYoutubeBroadcast();

  if (!targets.length) {
    container.innerHTML = `
      <div class="panel-stack">
        ${renderStatus('youtube-studio')}
        <div class="empty-state-inline">Connect YouTube first. This portal only shows real YouTube broadcast controls where the backend actually supports them.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="panel-stack">
      ${renderStatus('youtube-studio')}
      ${sessionLockCopy()}
      <div class="youtube-target-tabs">
        ${targets.map((entry) => {
          const current = getSelectedBroadcastForTarget(entry.id);
          const destination = findDestinationById(entry.id);
          return `
            <button class="youtube-tab ${entry.id === state.selectedYoutubeTargetId ? 'youtube-tab-active' : ''}" type="button" data-action="select-youtube-target" data-target-id="${escapeHtml(entry.id)}">
              <span>${escapeHtml(entry.name)}</span>
              <small>${escapeHtml(current?.title || 'No broadcast selected')}</small>
              ${statusChip(destination?.selected ? 'Auto-go-live approved' : 'Not approved', destination?.selected ? 'success' : 'muted')}
            </button>
          `;
        }).join('')}
      </div>
      <div class="youtube-layout">
        <article class="studio-card">
          <div class="section-head section-head-tight">
            <div>
              <p class="field-label">Broadcast library</p>
              <h3>${escapeHtml(target?.name || 'YouTube')}</h3>
            </div>
            <div class="panel-actions">
              <button class="btn btn-secondary" type="button" data-action="refresh-broadcasts" data-target-id="${escapeHtml(target?.id || '')}" ${!target || isBusy(`load-broadcasts-${target.id}`) ? 'disabled' : ''}>${target && isBusy(`load-broadcasts-${target.id}`) ? 'Loading…' : 'Refresh broadcasts'}</button>
            </div>
          </div>
          ${target ? renderStatus(`broadcast-list-${target.id}`) : ''}
          <div class="broadcast-list">
            ${target ? renderBroadcastList(target.id, broadcasts, selectedId) : ''}
          </div>
        </article>
        <div class="studio-stack">
          <details class="subordinate-shell studio-card" ${currentBroadcast ? '' : 'open'}>
            <summary>
              <div>
                <p class="field-label">Create and bind</p>
                <h3>Create a new YouTube broadcast</h3>
              </div>
              ${statusChip('Optional', 'muted')}
            </summary>
            <div class="subordinate-body panel-stack">
              ${renderStatus('youtube-create')}
              <form id="youtube-create-form" class="dense-form">
                <div class="field-grid field-grid-2">
                  <label class="field-shell">
                    <span>Title</span>
                    <input class="form-control" type="text" name="title" data-draft-section="youtubeCreate" value="${escapeHtml(state.drafts.youtubeCreate.title)}" placeholder="Sunday service">
                  </label>
                  <label class="field-shell">
                    <span>Privacy</span>
                    <select class="form-control" name="privacyStatus" data-draft-section="youtubeCreate">
                      ${YOUTUBE_PRIVACY.map((option) => `<option value="${option.value}" ${state.drafts.youtubeCreate.privacyStatus === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
                    </select>
                  </label>
                </div>
                <label class="field-shell">
                  <span>Description</span>
                  <textarea class="form-control textarea-control" name="description" data-draft-section="youtubeCreate" placeholder="Describe this broadcast">${escapeHtml(state.drafts.youtubeCreate.description)}</textarea>
                </label>
                <div class="field-grid field-grid-3">
                  <label class="field-shell">
                    <span>Scheduled start</span>
                    <input class="form-control" type="datetime-local" name="scheduledStartTime" data-draft-section="youtubeCreate" value="${escapeHtml(state.drafts.youtubeCreate.scheduledStartTime)}">
                  </label>
                  <label class="field-shell">
                    <span>Latency</span>
                    <select class="form-control" name="latencyPreference" data-draft-section="youtubeCreate">
                      ${YOUTUBE_LATENCIES.map((option) => `<option value="${option.value}" ${state.drafts.youtubeCreate.latencyPreference === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
                    </select>
                  </label>
                  <label class="field-shell">
                    <span>Category</span>
                    <input class="form-control" type="text" name="categoryId" data-draft-section="youtubeCreate" value="${escapeHtml(state.drafts.youtubeCreate.categoryId)}" placeholder="29">
                  </label>
                </div>
                <div class="panel-actions">
                  <button class="btn" type="submit" ${isSetupLocked() || isBusy('youtube-create') ? 'disabled' : ''}>${isBusy('youtube-create') ? 'Creating…' : 'Create and bind broadcast'}</button>
                </div>
              </form>
            </div>
          </details>
          <article class="studio-card">
            <div class="section-head section-head-tight">
              <div>
                <p class="field-label">Current broadcast</p>
                <h3>${escapeHtml(currentBroadcast?.title || 'No broadcast selected')}</h3>
              </div>
              ${currentBroadcast ? statusChip(titleCase(currentBroadcast.lifeCycleStatus || 'ready'), toneForBroadcast(currentBroadcast.lifeCycleStatus)) : statusChip('Select one first', 'muted')}
            </div>
            <p class="section-copy">Normal path: pick the broadcast here, keep privacy accurate, and enable the channel. Once OBS Start Streaming is clicked, approved YouTube channels should go live automatically without a second Go Live click. End broadcast still does not stop OBS.</p>
            ${renderStatus('youtube-update')}
            ${currentBroadcast ? `
              <div class="inline-status inline-status-pending auto-live-note">
                <strong>${escapeHtml(target?.name || 'This YouTube channel')}</strong>
                <span>${target?.selected ? ' is approved to auto-go-live when OBS starts streaming.' : ' is not approved yet. Enable this channel in Destinations if you want OBS start to send it live automatically.'}</span>
              </div>
              <details class="subordinate-shell" open>
                <summary>
                  <div>
                    <p class="field-label">Edit and transition</p>
                    <h3>Broadcast details and controls</h3>
                  </div>
                  ${statusChip('Open', 'warning')}
                </summary>
                <div class="subordinate-body panel-stack">
                  <form id="youtube-update-form" class="dense-form">
                    <div class="field-grid field-grid-2">
                      <label class="field-shell">
                        <span>Title</span>
                        <input class="form-control" type="text" name="title" data-draft-section="youtubeUpdate" value="${escapeHtml(state.drafts.youtubeUpdate.title)}">
                      </label>
                      <label class="field-shell">
                        <span>Privacy</span>
                        <select class="form-control" name="privacyStatus" data-draft-section="youtubeUpdate">
                          ${YOUTUBE_PRIVACY.map((option) => `<option value="${option.value}" ${state.drafts.youtubeUpdate.privacyStatus === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
                        </select>
                      </label>
                    </div>
                    <label class="field-shell">
                      <span>Description</span>
                      <textarea class="form-control textarea-control" name="description" data-draft-section="youtubeUpdate">${escapeHtml(state.drafts.youtubeUpdate.description)}</textarea>
                    </label>
                    <div class="field-grid field-grid-2">
                      <label class="field-shell">
                        <span>Latency</span>
                        <select class="form-control" name="latencyPreference" data-draft-section="youtubeUpdate">
                          ${YOUTUBE_LATENCIES.map((option) => `<option value="${option.value}" ${state.drafts.youtubeUpdate.latencyPreference === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
                        </select>
                      </label>
                      <label class="field-shell">
                        <span>Category</span>
                        <input class="form-control" type="text" name="categoryId" data-draft-section="youtubeUpdate" value="${escapeHtml(state.drafts.youtubeUpdate.categoryId)}">
                      </label>
                    </div>
                    <div class="field-grid field-grid-2 field-grid-tight">
                      <label class="field-shell">
                        <span>Thumbnail</span>
                        <input class="form-control" type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" data-action="thumbnail-input" data-target-id="${escapeHtml(target.id)}">
                      </label>
                      <div class="thumbnail-note">Keep it under 2MB here (JPEG or PNG only).</div>
                    </div>
                    <div class="panel-actions panel-actions-wrap">
                      <button class="btn" type="submit" ${isSetupLocked() || isBusy('youtube-update') ? 'disabled' : ''}>${isBusy('youtube-update') ? 'Saving…' : 'Save broadcast details'}</button>
                      <button class="btn btn-secondary" type="button" data-action="upload-thumbnail" data-target-id="${escapeHtml(target.id)}" ${isSetupLocked() || isBusy('youtube-thumbnail') ? 'disabled' : ''}>${isBusy('youtube-thumbnail') ? 'Uploading…' : 'Upload thumbnail'}</button>
                      <button class="btn btn-danger" type="button" data-action="transition-broadcast" data-target-id="${escapeHtml(target.id)}" data-status="complete" ${isBusy('youtube-transition') ? 'disabled' : ''}>End broadcast</button>
                    </div>
                  </form>
                </div>
              </details>
            ` : '<div class="empty-inline">Select an existing broadcast or create a new one for this channel first.</div>'}
          </article>
        </div>
      </div>
      <details class="subordinate-shell studio-card">
        <summary>
          <div>
            <p class="field-label">Bulk update</p>
            <h3>Push shared metadata across selected YouTube targets</h3>
          </div>
          ${statusChip(state.bulkResults.length ? `${state.bulkResults.length} results` : 'Optional', state.bulkResults.length ? 'warning' : 'muted')}
        </summary>
        <div class="subordinate-body panel-stack">
          <p class="section-copy">This bulk editor only changes selected YouTube destinations. Other providers stay visible here without joining the YouTube metadata update flow.</p>
          ${renderStatus('youtube-bulk')}
          <form id="youtube-bulk-form" class="dense-form">
            <div class="field-grid field-grid-2">
              <label class="field-shell">
                <span>Shared title</span>
                <input class="form-control" type="text" name="title" data-draft-section="youtubeBulk" value="${escapeHtml(state.drafts.youtubeBulk.title)}" placeholder="Weekend stream">
              </label>
              <label class="field-shell">
                <span>Privacy</span>
                <select class="form-control" name="privacyStatus" data-draft-section="youtubeBulk">
                  ${YOUTUBE_PRIVACY.map((option) => `<option value="${option.value}" ${state.drafts.youtubeBulk.privacyStatus === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
                </select>
              </label>
            </div>
            <label class="field-shell">
              <span>Shared description</span>
              <textarea class="form-control textarea-control" name="description" data-draft-section="youtubeBulk">${escapeHtml(state.drafts.youtubeBulk.description)}</textarea>
            </label>
            <div class="field-grid field-grid-2">
              <label class="field-shell">
                <span>Latency</span>
                <select class="form-control" name="latencyPreference" data-draft-section="youtubeBulk">
                  ${YOUTUBE_LATENCIES.map((option) => `<option value="${option.value}" ${state.drafts.youtubeBulk.latencyPreference === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
                </select>
              </label>
              <label class="field-shell">
                <span>Category</span>
                <input class="form-control" type="text" name="categoryId" data-draft-section="youtubeBulk" value="${escapeHtml(state.drafts.youtubeBulk.categoryId)}" placeholder="29">
              </label>
            </div>
            <div class="bulk-target-list">
              ${selectedDestinations().length ? selectedDestinations().map((destination) => `
                <label class="bulk-target-row">
                  <input type="checkbox" data-action="toggle-bulk-target" data-target-id="${escapeHtml(destination.id)}" ${destination.provider === 'youtube' && state.drafts.youtubeBulk.targetIds.includes(destination.id) ? 'checked' : ''} ${destination.provider !== 'youtube' || isSetupLocked() ? 'disabled' : ''}>
                  <span>
                    <strong>${escapeHtml(destination.name)}</strong>
                    <small>${escapeHtml(destination.provider === 'youtube' ? 'Included in YouTube bulk updates' : `Visible here, but not included in YouTube bulk updates`)}</small>
                  </span>
                </label>
              `).join('') : '<div class="empty-inline">Turn on at least one destination to include it in bulk updates.</div>'}
            </div>
            <div class="panel-actions">
              <button class="btn" type="submit" ${isSetupLocked() || isBusy('youtube-bulk') ? 'disabled' : ''}>${isBusy('youtube-bulk') ? 'Updating…' : 'Run bulk update'}</button>
            </div>
          </form>
          ${state.bulkResults.length ? `
            <div class="bulk-results">
              ${state.bulkResults.map((result) => `<div class="bulk-result bulk-result-${escapeHtml(result.type)}"><strong>${escapeHtml(result.name)}</strong><span>${escapeHtml(result.message)}</span></div>`).join('')}
            </div>
          ` : ''}
        </div>
      </details>
    </div>
  `;
}

function pairingBlockedReason() {
  const entitlement = getWorkspaceEntitlement();
  if (entitlement.plan !== 'pro' || Number(entitlement.maxDevices) <= 0 || entitlement.canStream !== true) {
    return 'This workspace cannot pair a device on the Free plan.';
  }
  return '';
}

function renderDevicesPanel() {
  const devices = state.setup.devices || [];
  const activeDevice = selectedDevice();
  const pairingBlocked = pairingBlockedReason();
  document.getElementById('devices-panel').innerHTML = `
    <div class="panel-stack">
      ${renderStatus('devices')}
      <div class="pairing-shell">
        <div>
          <p class="field-label">Pairing</p>
          <h3>${pairingBlocked ? 'Pairing unavailable' : 'Create a short pairing code'}</h3>
          <p class="section-copy">${escapeHtml(pairingBlocked || 'The dock uses this short-lived code once, then keeps its own device session.')}</p>
        </div>
        <form id="pairing-code-form" class="pairing-inline-form">
          <input class="form-control" type="text" name="deviceName" value="${escapeHtml(state.linkCode?.deviceName || '')}" placeholder="Front left encoder" ${isSetupLocked() || pairingBlocked ? 'disabled' : ''}>
          <button class="btn" type="submit" ${isSetupLocked() || pairingBlocked || isBusy('pairing-code') ? 'disabled' : ''}>${isBusy('pairing-code') ? 'Generating…' : 'Generate code'}</button>
        </form>
        ${state.linkCode ? `
          <div class="pairing-live-card">
            <div>
              <p class="field-label">Current pairing code</p>
              <div class="pairing-code mono-value">${escapeHtml(state.linkCode.code)}</div>
              <div class="pairing-timer" id="link-code-timer">Expires ${escapeHtml(formatRelativeTime(state.linkCode.expiresAt))}</div>
            </div>
            <div class="panel-actions">
              <button class="btn btn-secondary" type="button" data-action="copy-link-code">Copy code</button>
            </div>
          </div>
        ` : ''}
      </div>
      <div class="device-list-shell">
        ${devices.length ? devices.map((device) => `
          <article class="device-row ${device.id === activeDevice?.id ? 'device-row-active' : ''}">
            <div>
              <div class="device-row-title">
                <strong>${escapeHtml(device.name)}</strong>
                ${statusChip(titleCase(device.status || 'unknown'), device.status === 'active' ? 'success' : device.status === 'pending' ? 'warning' : 'muted')}
              </div>
              <div class="destination-row-copy">ID: ${escapeHtml(device.id)}</div>
              <div class="destination-row-extra">${device.linked_at ? `Linked ${escapeHtml(formatDateTime(device.linked_at))}` : 'Awaiting first dock pair'} · ${deviceHasKey(device) ? `Key ends ••••${escapeHtml(device.ingest_key_last4)}` : 'No OBS key yet'}</div>
            </div>
            <div class="panel-actions panel-actions-wrap">
              <button class="btn btn-secondary" type="button" data-action="select-device" data-device-id="${escapeHtml(device.id)}">${device.id === activeDevice?.id ? 'Selected for setup' : 'Use in encoder panel'}</button>
              <button class="btn btn-secondary" type="button" data-action="rotate-ingest-key" data-device-id="${escapeHtml(device.id)}" ${device.status !== 'active' || isSetupLocked() || isBusy(`rotate-device-${device.id}`) ? 'disabled' : ''}>${deviceHasKey(device) ? 'Rotate key' : 'Set up key'}</button>
              <button class="btn btn-danger" type="button" data-action="revoke-device" data-device-id="${escapeHtml(device.id)}" ${isSetupLocked() || isBusy(`revoke-device-${device.id}`) ? 'disabled' : ''}>Revoke</button>
            </div>
          </article>
        `).join('') : '<div class="empty-state-inline">No devices paired yet.</div>'}
      </div>
    </div>
  `;
}

function renderSubscriptionPanel() {
  const ws = state.activeWorkspace;
  if (!ws) return;
  const plan = getWorkspacePlan();
  const entitlement = getWorkspaceEntitlement();
  const subscription = getWorkspaceSubscription();
  const mode = currentBillingMode();
  const manager = isBillingManager();
  const stickyNotice = consumeBillingStickyNotice();
  if (stickyNotice) setStatus('billing', stickyNotice.type, stickyNotice.message);
  const statusCopy = state.billing.summaryError
    ? state.billing.summaryError
    : entitlement.plan === 'pro'
      ? entitlement.cancelAtPeriodEnd
        ? `Pro access stays on until ${formatPaidUntil(entitlement.paidUntil)}, then new streams stop while any live stream gets up to two hours to finish.`
        : `Pro access is active${entitlement.paidUntil ? ` until ${formatPaidUntil(entitlement.paidUntil)}` : ''}.`
      : 'Free local Bible, text, media, camera, and setup tools stay usable even if you cancel paid streaming.';
  const manageLabel = subscription.manageAvailable ? 'Manage subscription' : 'Portal unavailable';
  const modeTone = mode === 'live' ? 'success' : mode === 'test' ? 'warning' : 'muted';
  const canCheckout = manager && isCheckoutAvailable() && entitlement.plan !== 'pro';
  const canManage = manager && !!subscription.manageAvailable;
  const limitSummary = entitlement.plan === 'pro'
    ? 'One active broadcast workspace at a time, with up to three paired OBS devices and three simultaneous destinations.'
    : 'Free keeps the local operator workflow. Paid is only for the streaming control service.';
  document.getElementById('subscription-panel').innerHTML = `
    <div class="panel-stack subscription-stack">
      ${renderStatus('billing')}
      ${renderBillingReturnNotice()}
      <section class="subscription-hero ${entitlement.plan === 'pro' ? 'subscription-hero-pro' : ''}">
        <div>
          <p class="field-label">Workspace billing</p>
          <h3>${escapeHtml(ws.name)}</h3>
          <p class="section-copy">${escapeHtml(statusCopy)}</p>
          <div class="billing-pill-row">
            ${statusChip(entitlement.plan === 'pro' ? 'Emberstage Pro' : 'Free local core', entitlement.plan === 'pro' ? 'success' : 'muted')}
            ${subscription.status && subscription.status !== 'none' ? statusChip(titleCase(subscription.status), entitlement.plan === 'pro' ? 'success' : 'warning') : ''}
            ${statusChip(billingModeLabel(mode), modeTone)}
          </div>
        </div>
        <div class="subscription-price-panel ${entitlement.plan === 'pro' ? '' : 'is-free'}">
          <span class="subscription-price-kicker">${entitlement.plan === 'pro' ? 'Current plan' : 'Current plan'}</span>
          <strong class="subscription-price">${escapeHtml(entitlement.plan === 'pro' ? formatPlanPrice(plan) : 'Free')}</strong>
          <span class="subscription-price-note">${escapeHtml(entitlement.plan === 'pro' ? 'Per workspace' : 'Pairing and paid destinations are not included.')}</span>
        </div>
      </section>
      <div class="metric-strip metric-strip-3">
        <article class="metric-tile"><span>${entitlement.plan === 'pro' ? 'Paired devices' : 'Devices on this plan'}</span><strong>${escapeHtml(entitlement.plan === 'pro' ? plan.maxDevices : entitlement.maxDevices)}</strong></article>
        <article class="metric-tile"><span>${entitlement.plan === 'pro' ? 'Destinations' : 'Destinations on this plan'}</span><strong>${escapeHtml(entitlement.plan === 'pro' ? plan.maxDestinations : entitlement.maxDestinations)}</strong></article>
        <article class="metric-tile"><span>${entitlement.plan === 'pro' ? 'Active broadcasts' : 'Active broadcasts on this plan'}</span><strong>${escapeHtml(entitlement.plan === 'pro' ? plan.maxActiveBroadcasts : entitlement.maxActiveBroadcasts)}</strong></article>
      </div>
      <div class="billing-card-grid">
        <article class="billing-card billing-card-accent">
          <p class="field-label">What paid covers</p>
          <h3>Streaming control service</h3>
          <p class="section-copy">${escapeHtml(limitSummary)}</p>
          <p class="billing-mini-note">Automatic approved destination go-live follows OBS start. Platform permissions and server configuration still decide what each provider allows.</p>
        </article>
        <article class="billing-card">
          <p class="field-label">Paid until</p>
          <h3>${escapeHtml(entitlement.paidUntil ? formatPaidUntil(entitlement.paidUntil) : 'No paid period recorded')}</h3>
          <p class="section-copy">${escapeHtml(entitlement.cancelAtPeriodEnd ? 'Cancellation is scheduled. Free features and saved config stay intact.' : entitlement.canStream ? 'This workspace can start new streams right now.' : 'At paid expiry, new streams stop. Existing streams may finish within two hours.')}</p>
        </article>
        <article class="billing-card">
          <p class="field-label">Your access</p>
          <h3>${escapeHtml(roleLabel(state.activeWorkspaceRole))}</h3>
          <p class="section-copy">${escapeHtml(manager ? 'You can open checkout or manage the subscription for this workspace.' : 'Billing actions are read-only for operators. Ask a workspace owner or finance member to manage payment.')}</p>
        </article>
      </div>
      <div class="billing-detail-list">
        <div class="billing-detail-row"><span>Checkout mode</span><strong>${escapeHtml(billingModeCopy(mode))}</strong></div>
        <div class="billing-detail-row"><span>Cancel anytime</span><strong>${escapeHtml(entitlement.plan === 'pro' ? 'Yes. Paid access runs until period end.' : 'Upgrade only when you need streaming control.')}</strong></div>
        <div class="billing-detail-row"><span>Relay hosting</span><strong>Requires a configured relay; unlimited bandwidth is not included.</strong></div>
      </div>
      <div class="panel-actions panel-actions-wrap">
        <button class="btn" type="button" data-action="billing-checkout" ${(canCheckout && !isBusy('billing-checkout')) ? '' : 'disabled'}>${isBusy('billing-checkout') ? 'Opening…' : entitlement.plan === 'pro' ? 'Pro is active' : mode === 'test' ? 'Try test checkout' : 'Upgrade'}</button>
        <button class="btn btn-secondary" type="button" data-action="billing-portal" ${(canManage && !isBusy('billing-portal')) ? '' : 'disabled'}>${isBusy('billing-portal') ? 'Opening…' : manageLabel}</button>
      </div>
      ${!manager ? '<div class="inline-status inline-status-muted">Operators can review usage, expiry, and plan limits here, but only owner or finance roles can open billing actions.</div>' : ''}
      ${!isCheckoutAvailable() ? `<div class="inline-status inline-status-${mode === 'unconfigured' ? 'warning' : 'muted'}">${escapeHtml(billingCheckoutReason())}</div>` : ''}
    </div>
  `;
}

function renderApp() {
  renderCommandStage();
  renderEncoderPanel();
  renderChannelsPanel();
  renderYouTubeStudio();
  renderDevicesPanel();
  renderSubscriptionPanel();
}

function startLinkCodeCountdown(expiresAt) {
  if (state.linkCodeTimerInterval) clearInterval(state.linkCodeTimerInterval);
  const tick = () => {
    const el = document.getElementById('link-code-timer');
    if (!el || !state.linkCode?.expiresAt) return;
    const diff = new Date(state.linkCode.expiresAt).getTime() - Date.now();
    if (diff <= 0) {
      el.textContent = 'Expired. Generate a fresh code.';
      el.style.color = 'var(--color-danger)';
      clearInterval(state.linkCodeTimerInterval);
      state.linkCodeTimerInterval = null;
      return;
    }
    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    el.textContent = `Expires in ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    el.style.color = 'var(--text-muted)';
  };
  tick();
  state.linkCodeTimerInterval = setInterval(tick, 1000);
}

function modalBackdrop() {
  return document.getElementById('portal-modal');
}

function modalContent() {
  return document.getElementById('portal-modal-content');
}

function closeModal(result = false) {
  const backdrop = modalBackdrop();
  backdrop.style.display = 'none';
  backdrop.setAttribute('aria-hidden', 'true');
  modalContent().innerHTML = '';
  const resolver = state.ui.modal.resolver;
  const restoreFocusTo = state.ui.modal.restoreFocusTo;
  state.ui.modal.open = false;
  state.ui.modal.resolver = null;
  state.ui.modal.restoreFocusTo = null;
  state.ui.modal.card = null;
  if (restoreFocusTo && typeof restoreFocusTo.focus === 'function') restoreFocusTo.focus();
  if (resolver) resolver(result);
}

function openConfirmModal(options) {
  const active = document.activeElement;
  const backdrop = modalBackdrop();
  const content = modalContent();
  content.innerHTML = `
    <div class="modal-stack">
      <div>
        <p class="field-label">Confirm action</p>
        <h2 id="portal-modal-title">${escapeHtml(options.title)}</h2>
      </div>
      <p class="section-copy">${escapeHtml(options.copy)}</p>
      <div class="panel-actions panel-actions-wrap">
        <button class="btn ${options.confirmTone === 'danger' ? 'btn-danger' : ''}" type="button" data-modal-action="confirm">${escapeHtml(options.confirmLabel)}</button>
        <button class="btn btn-secondary" type="button" data-modal-action="cancel">${escapeHtml(options.cancelLabel || 'Cancel')}</button>
      </div>
    </div>
  `;
  backdrop.style.display = 'flex';
  backdrop.setAttribute('aria-hidden', 'false');
  state.ui.modal.open = true;
  state.ui.modal.restoreFocusTo = active;
  state.ui.modal.card = backdrop.querySelector('.modal-card');
  const confirmButton = content.querySelector('[data-modal-action="confirm"]');
  if (confirmButton) confirmButton.focus();
  return new Promise((resolve) => {
    state.ui.modal.resolver = resolve;
  });
}

function trapModalFocus(event) {
  if (!state.ui.modal.open || event.key !== 'Tab') return;
  const card = state.ui.modal.card;
  if (!card) return;
  const focusable = Array.from(card.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter((element) => !element.hasAttribute('hidden') && element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function updateDraftFromInput(target) {
  const section = target.dataset.draftSection;
  if (!section || !state.drafts[section]) return;
  state.drafts[section][target.name] = target.value;
}

async function ensureYoutubeBroadcasts(targetId, options = {}) {
  if (!targetId) return [];
  if (!options.force && state.youtubeBroadcasts[targetId]) return state.youtubeBroadcasts[targetId];
  setBusy(`load-broadcasts-${targetId}`, true, { visual: options.silent !== true });
  renderYouTubeStudio();
  try {
    const result = await apiCall('GET', `/api/workspaces/${state.activeWorkspaceId}/providers/targets/${targetId}/broadcasts`);
    state.youtubeBroadcasts[targetId] = result?.broadcasts || [];
    if (result?.selectedBroadcastId) state.youtubeBroadcastSelections[targetId] = result.selectedBroadcastId;
    const selected = getSelectedBroadcastForTarget(targetId);
    if (selected && targetId === state.selectedYoutubeTargetId) hydrateDraftsFromBroadcast(selected);
    if (!options.silent) setStatus(`broadcast-list-${targetId}`, 'success', 'Broadcast list refreshed.');
  } catch (error) {
    if (!options.silent) setStatus(`broadcast-list-${targetId}`, 'danger', apiErrorMessage(error));
  } finally {
    setBusy(`load-broadcasts-${targetId}`, false);
    renderYouTubeStudio();
  }
  return state.youtubeBroadcasts[targetId] || [];
}

async function refreshWorkspaceAfterMutation(statusKey, message) {
  await loadWorkspaceData({ silent: true });
  if (statusKey && message) setStatus(statusKey, 'success', message);
  renderApp();
}

async function copyText(value, successMessage, failureKey) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    if (failureKey) setStatus(failureKey, 'success', successMessage);
  } catch (_) {
    if (failureKey) setStatus(failureKey, 'danger', 'Copy failed. Copy it manually.');
  }
}

async function handleRotateIngestKey(deviceId) {
  const device = (state.setup.devices || []).find((entry) => entry.id === deviceId);
  if (!device) return;
  if (deviceHasKey(device)) {
    const confirmed = await openConfirmModal({
      title: `Rotate OBS key for ${device.name}?`,
      copy: 'The old OBS key stops working immediately. Emberstage cannot recover the old raw key later.',
      confirmLabel: 'Rotate key',
      confirmTone: 'danger'
    });
    if (!confirmed) return;
  }
  setBusy(`rotate-device-${deviceId}`, true);
  setStatus('encoder', 'pending', 'Generating a new one-time OBS key…');
  renderEncoderPanel();
  renderDevicesPanel();
  try {
    const result = await apiCall('POST', `/api/workspaces/${state.activeWorkspaceId}/devices/${deviceId}/ingest-key/rotate`);
    state.ingestCredentials = {
      deviceId,
      ingestServer: result.ingestServer,
      streamKey: result.streamKey,
      rotatedAt: result.rotatedAt,
      revealed: false
    };
    await refreshWorkspaceAfterMutation('encoder', 'New OBS key generated. It is hidden by default and only available now.');
    setStatus('devices', 'success', `New OBS key generated for ${device.name}.`);
  } catch (error) {
    const message = apiErrorMessage(error);
    setStatus('encoder', 'danger', message);
    setStatus('devices', 'danger', message);
  } finally {
    setBusy(`rotate-device-${deviceId}`, false);
    renderEncoderPanel();
    renderDevicesPanel();
  }
}

async function handleRevokeDevice(deviceId) {
  const device = (state.setup.devices || []).find((entry) => entry.id === deviceId);
  if (!device) return;
  const confirmed = await openConfirmModal({
    title: `Revoke ${device.name}?`,
    copy: 'This removes the dock session and the stored OBS key for that device. Pair it again later if needed.',
    confirmLabel: 'Revoke device',
    confirmTone: 'danger'
  });
  if (!confirmed) return;
  setBusy(`revoke-device-${deviceId}`, true);
  setStatus('devices', 'pending', `Revoking ${device.name}…`);
  renderDevicesPanel();
  try {
    await apiCall('POST', `/api/workspaces/${state.activeWorkspaceId}/devices/${deviceId}/revoke`);
    if (state.ingestCredentials?.deviceId === deviceId) state.ingestCredentials = null;
    await refreshWorkspaceAfterMutation('devices', `${device.name} revoked.`);
  } catch (error) {
    setStatus('devices', 'danger', apiErrorMessage(error));
  } finally {
    setBusy(`revoke-device-${deviceId}`, false);
    renderDevicesPanel();
  }
}

async function handleConnectProvider(provider) {
  setBusy(`provider-connect-${provider}`, true);
  setStatus(`provider-${provider}`, 'pending', `Opening ${titleCase(provider)} connection…`);
  renderChannelsPanel();
  const connectWindow = window.open('about:blank', '_blank');
  if (connectWindow) connectWindow.opener = null;
  try {
    const result = await apiCall('POST', `/api/workspaces/${state.activeWorkspaceId}/providers/${provider}/connect`);
    const url = result?.url || result?.authorizationUrl;
    if (!url) throw new Error('No connection URL was returned.');
    if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Invalid connection URL.');
    if (connectWindow && !connectWindow.closed) connectWindow.location.href = url;
    setStatus(`provider-${provider}`, 'success', `Finish ${titleCase(provider)} sign-in in the other tab, then return here.`);
    if (!connectWindow || connectWindow.closed) {
      setStatus(`provider-${provider}`, 'warning', 'Your browser blocked the sign-in tab. Continue using the link below.');
      state.ui.statuses[`provider-${provider}`].connectUrl = url;
    }
  } catch (error) {
    if (connectWindow && !connectWindow.closed) connectWindow.close();
    setStatus(`provider-${provider}`, 'danger', apiErrorMessage(error));
  } finally {
    setBusy(`provider-connect-${provider}`, false);
    renderChannelsPanel();
  }
}

async function handleDisconnectProvider(provider) {
  const confirmed = await openConfirmModal({
    title: `Disconnect ${titleCase(provider)}?`,
    copy: 'Channel discovery and provider access for this provider will be removed until you reconnect it.',
    confirmLabel: 'Disconnect provider',
    confirmTone: 'danger'
  });
  if (!confirmed) return;
  setBusy(`provider-disconnect-${provider}`, true);
  setStatus(`provider-${provider}`, 'pending', `Disconnecting ${titleCase(provider)}…`);
  renderChannelsPanel();
  try {
    await apiCall('POST', `/api/workspaces/${state.activeWorkspaceId}/providers/${provider}/disconnect`);
    await refreshWorkspaceAfterMutation('channels', `${titleCase(provider)} disconnected.`);
  } catch (error) {
    setStatus(`provider-${provider}`, 'danger', apiErrorMessage(error));
  } finally {
    setBusy(`provider-disconnect-${provider}`, false);
    renderChannelsPanel();
  }
}

async function toggleDestinationSelection(targetId, selected) {
  const destination = findDestinationById(targetId);
  if (!destination) return;
  setBusy(`toggle-target-${targetId}`, true);
  setStatus('channels', 'pending', `${selected ? 'Approving' : 'Removing'} ${destination.name}…`);
  renderChannelsPanel();
  try {
    const path = destination.type === 'custom'
      ? `/api/workspaces/${state.activeWorkspaceId}/streams/custom-targets/${targetId}/${selected ? 'select' : 'deselect'}`
      : `/api/workspaces/${state.activeWorkspaceId}/providers/targets/${targetId}/${selected ? 'select' : 'deselect'}`;
    await apiCall('POST', path);
    await refreshWorkspaceAfterMutation('channels', `${destination.name} ${selected ? 'approved to auto-go-live with OBS' : 'removed from OBS auto-go-live approval'}.`);
  } catch (error) {
    setStatus('channels', 'danger', apiErrorMessage(error));
  } finally {
    setBusy(`toggle-target-${targetId}`, false);
    renderChannelsPanel();
  }
}

async function handleDeleteCustomTarget(targetId) {
  const target = state.customTargets.find((entry) => entry.id === targetId);
  if (!target) return;
  const confirmed = await openConfirmModal({
    title: `Delete ${target.name}?`,
    copy: 'This removes the stored custom RTMP relay destination from the workspace.',
    confirmLabel: 'Delete target',
    confirmTone: 'danger'
  });
  if (!confirmed) return;
  setBusy(`delete-custom-target-${targetId}`, true);
  setStatus('custom-targets', 'pending', `Deleting ${target.name}…`);
  renderChannelsPanel();
  try {
    await apiCall('DELETE', `/api/workspaces/${state.activeWorkspaceId}/streams/custom-targets/${targetId}`);
    await refreshWorkspaceAfterMutation('custom-targets', `${target.name} removed.`);
  } catch (error) {
    setStatus('custom-targets', 'danger', apiErrorMessage(error));
  } finally {
    setBusy(`delete-custom-target-${targetId}`, false);
    renderChannelsPanel();
  }
}

async function handleGeneratePairingCode(form) {
  const blocked = pairingBlockedReason();
  if (blocked) {
    setStatus('devices', 'warning', blocked);
    renderDevicesPanel();
    return;
  }
  const input = form.querySelector('[name="deviceName"]');
  const deviceName = input?.value.trim();
  if (!deviceName) {
    setStatus('devices', 'danger', 'Enter a device name before generating a pairing code.');
    renderDevicesPanel();
    input?.focus();
    return;
  }
  setBusy('pairing-code', true);
  setStatus('devices', 'pending', 'Generating pairing code…');
  renderDevicesPanel();
  try {
    const result = await apiCall('POST', `/api/workspaces/${state.activeWorkspaceId}/devices/link-code`, { name: deviceName });
    state.linkCode = { code: result.linkCode, expiresAt: result.expiresAt, deviceName };
    startLinkCodeCountdown(result.expiresAt);
    await refreshWorkspaceAfterMutation('devices', 'Pairing code ready. Enter it in the OBS dock within ten minutes.');
  } catch (error) {
    setStatus('devices', 'danger', apiErrorMessage(error));
  } finally {
    setBusy('pairing-code', false);
    renderDevicesPanel();
  }
}

async function handleCreateCustomTarget(form) {
  const formData = new FormData(form);
  const payload = {
    name: String(formData.get('name') || '').trim(),
    stream_url: String(formData.get('stream_url') || '').trim(),
    stream_key: String(formData.get('stream_key') || '').trim()
  };
  if (!payload.name || !payload.stream_url || !payload.stream_key) {
    setStatus('custom-targets', 'danger', 'Name, RTMP URL, and stream key are all required.');
    renderChannelsPanel();
    return;
  }
  setBusy('create-custom-target', true);
  setStatus('custom-targets', 'pending', 'Adding custom RTMP destination…');
  renderChannelsPanel();
  try {
    await apiCall('POST', `/api/workspaces/${state.activeWorkspaceId}/streams/custom-targets`, payload);
    state.drafts.customTarget = { name: '', stream_url: '', stream_key: '' };
    await refreshWorkspaceAfterMutation('custom-targets', 'Custom RTMP destination added.');
  } catch (error) {
    setStatus('custom-targets', 'danger', apiErrorMessage(error));
  } finally {
    setBusy('create-custom-target', false);
    renderChannelsPanel();
  }
}

async function handleCreateBroadcast(form) {
  const target = selectedYoutubeTarget();
  if (!target) return;
  const formData = new FormData(form);
  const payload = {
    title: String(formData.get('title') || '').trim(),
    description: String(formData.get('description') || '').trim(),
    privacyStatus: String(formData.get('privacyStatus') || 'private').toLowerCase(),
    scheduledStartTime: fromLocalDateTimeInput(String(formData.get('scheduledStartTime') || '')),
    latencyPreference: String(formData.get('latencyPreference') || 'normal'),
    categoryId: String(formData.get('categoryId') || '').trim() || undefined
  };
  if (!payload.title) {
    setStatus('youtube-create', 'danger', 'A title is required to create a YouTube broadcast.');
    renderYouTubeStudio();
    return;
  }
  setBusy('youtube-create', true);
  setStatus('youtube-create', 'pending', `Creating a broadcast for ${target.name}…`);
  renderYouTubeStudio();
  try {
    const result = await apiCall('POST', `/api/workspaces/${state.activeWorkspaceId}/providers/targets/${target.id}/broadcasts`, payload);
    state.youtubeBroadcastSelections[target.id] = result?.broadcast?.id || '';
    state.youtubeBroadcasts[target.id] = null;
    await refreshWorkspaceAfterMutation('youtube-create', `Broadcast created and selected for ${target.name}.`);
    await ensureYoutubeBroadcasts(target.id, { force: true, silent: true });
  } catch (error) {
    setStatus('youtube-create', 'danger', apiErrorMessage(error));
  } finally {
    setBusy('youtube-create', false);
    renderYouTubeStudio();
  }
}

async function handleSelectBroadcast(targetId, broadcastId) {
  setBusy(`select-broadcast-${targetId}`, true);
  setStatus(`broadcast-list-${targetId}`, 'pending', 'Selecting broadcast…');
  renderYouTubeStudio();
  try {
    const result = await apiCall('POST', `/api/workspaces/${state.activeWorkspaceId}/providers/targets/${targetId}/broadcasts/select`, { broadcastId });
    state.youtubeBroadcastSelections[targetId] = result?.broadcast?.id || broadcastId;
    await refreshWorkspaceAfterMutation('youtube-update', 'Broadcast selection updated.');
    await ensureYoutubeBroadcasts(targetId, { force: true, silent: true });
  } catch (error) {
    setStatus(`broadcast-list-${targetId}`, 'danger', apiErrorMessage(error));
  } finally {
    setBusy(`select-broadcast-${targetId}`, false);
    renderYouTubeStudio();
  }
}

async function handleUpdateBroadcast(form) {
  const target = selectedYoutubeTarget();
  const broadcast = selectedYoutubeBroadcast();
  if (!target || !broadcast) {
    setStatus('youtube-update', 'danger', 'Select a broadcast before saving details.');
    renderYouTubeStudio();
    return;
  }
  const formData = new FormData(form);
  const payload = {
    title: String(formData.get('title') || '').trim(),
    description: String(formData.get('description') || '').trim(),
    privacyStatus: String(formData.get('privacyStatus') || 'private').toLowerCase(),
    latencyPreference: String(formData.get('latencyPreference') || 'normal'),
    categoryId: String(formData.get('categoryId') || '').trim() || undefined
  };
  setBusy('youtube-update', true);
  setStatus('youtube-update', 'pending', 'Saving YouTube broadcast details…');
  renderYouTubeStudio();
  try {
    await apiCall('POST', `/api/workspaces/${state.activeWorkspaceId}/providers/targets/${target.id}/broadcasts/update`, payload);
    await refreshWorkspaceAfterMutation('youtube-update', 'Broadcast details saved.');
    await ensureYoutubeBroadcasts(target.id, { force: true, silent: true });
  } catch (error) {
    setStatus('youtube-update', 'danger', apiErrorMessage(error));
  } finally {
    setBusy('youtube-update', false);
    renderYouTubeStudio();
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleUploadThumbnail(targetId) {
  const file = state.youtubeThumbnailFiles[targetId];
  if (!file) {
    setStatus('youtube-update', 'danger', 'Choose a thumbnail file first.');
    renderYouTubeStudio();
    return;
  }
  const isJpeg = file.type === 'image/jpeg' || file.name.toLowerCase().endsWith('.jpg') || file.name.toLowerCase().endsWith('.jpeg');
  const isPng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
  if (!isJpeg && !isPng) {
    setStatus('youtube-update', 'danger', 'Thumbnail must be a JPEG or PNG image.');
    renderYouTubeStudio();
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    setStatus('youtube-update', 'danger', 'Keep the thumbnail under 2MB.');
    renderYouTubeStudio();
    return;
  }
  setBusy('youtube-thumbnail', true);
  setStatus('youtube-update', 'pending', 'Uploading thumbnail…');
  renderYouTubeStudio();
  try {
    const dataBase64 = await fileToBase64(file);
    await apiCall('POST', `/api/workspaces/${state.activeWorkspaceId}/providers/targets/${targetId}/broadcasts/thumbnail`, {
      contentType: file.type || 'image/jpeg',
      dataBase64
    });
    delete state.youtubeThumbnailFiles[targetId];
    await refreshWorkspaceAfterMutation('youtube-update', 'Thumbnail uploaded.');
    await ensureYoutubeBroadcasts(targetId, { force: true, silent: true });
  } catch (error) {
    setStatus('youtube-update', 'danger', apiErrorMessage(error));
  } finally {
    setBusy('youtube-thumbnail', false);
    renderYouTubeStudio();
  }
}

async function handleTransitionBroadcast(targetId, status) {
  const action = status === 'live' ? 'Go live on YouTube' : 'End YouTube broadcast';
  const confirmed = await openConfirmModal({
    title: `${action}?`,
    copy: status === 'live'
      ? 'This only transitions the selected YouTube broadcast. It does not start OBS or make any other destination public.'
      : 'This only completes the selected YouTube broadcast. It does not stop OBS or change ingest state by itself.',
    confirmLabel: action,
    confirmTone: status === 'complete' ? 'danger' : 'success'
  });
  if (!confirmed) return;
  setBusy('youtube-transition', true);
  setStatus('youtube-update', 'pending', `${action}…`);
  renderYouTubeStudio();
  try {
    await apiCall('POST', `/api/workspaces/${state.activeWorkspaceId}/providers/targets/${targetId}/broadcasts/transition`, { status });
    await refreshWorkspaceAfterMutation('youtube-update', `${action} complete.`);
    await ensureYoutubeBroadcasts(targetId, { force: true, silent: true });
  } catch (error) {
    setStatus('youtube-update', 'danger', apiErrorMessage(error));
  } finally {
    setBusy('youtube-transition', false);
    renderYouTubeStudio();
  }
}

async function handleBulkUpdate(form) {
  const selected = selectedDestinations();
  if (!selected.length) {
    setStatus('youtube-bulk', 'danger', 'Turn on at least one destination before running a bulk update.');
    renderYouTubeStudio();
    return;
  }
  const formData = new FormData(form);
  const payload = {
    title: String(formData.get('title') || '').trim(),
    description: String(formData.get('description') || '').trim(),
    privacyStatus: String(formData.get('privacyStatus') || 'private').toLowerCase(),
    latencyPreference: String(formData.get('latencyPreference') || 'normal'),
    categoryId: String(formData.get('categoryId') || '').trim() || undefined
  };
  const allowedIds = new Set(state.drafts.youtubeBulk.targetIds);
  const results = [];
  setBusy('youtube-bulk', true);
  setStatus('youtube-bulk', 'pending', 'Running bulk YouTube update…');
  renderYouTubeStudio();
  for (const destination of selected) {
    if (destination.provider !== 'youtube') {
      results.push({ name: destination.name, type: 'muted', message: `${titleCase(destination.provider)} is not supported for bulk broadcast updates.` });
      continue;
    }
    if (!allowedIds.has(destination.id)) {
      results.push({ name: destination.name, type: 'muted', message: 'Skipped because this target was not checked in the bulk list.' });
      continue;
    }
    if (!getSelectedBroadcastForTarget(destination.id)) {
      results.push({ name: destination.name, type: 'warning', message: 'Skipped because no YouTube broadcast is selected yet.' });
      continue;
    }
    try {
      await apiCall('POST', `/api/workspaces/${state.activeWorkspaceId}/providers/targets/${destination.id}/broadcasts/update`, payload);
      results.push({ name: destination.name, type: 'success', message: 'Broadcast details updated.' });
    } catch (error) {
      results.push({ name: destination.name, type: 'danger', message: apiErrorMessage(error) });
    }
  }
  state.bulkResults = results;
  try {
    await loadWorkspaceData({ silent: true });
    setStatus('youtube-bulk', 'success', 'Bulk update finished. Review each target outcome below.');
  } finally {
    setBusy('youtube-bulk', false);
    renderYouTubeStudio();
  }
}

async function handleBillingCheckout() {
  if (!isBillingManager() || !isCheckoutAvailable() || getWorkspaceEntitlement().plan === 'pro' || isBusy('billing-checkout')) return;
  setBusy('billing-checkout', true);
  setStatus('billing', 'pending', 'Checking upgrade availability…');
  renderSubscriptionPanel();
  try {
    const result = await apiCall('POST', `/api/workspaces/${state.activeWorkspaceId}/billing/checkout`);
    if (result?.url) {
      window.location.href = result.url;
      return;
    }
    throw new Error('Billing checkout URL was not returned.');
  } catch (error) {
    setStatus('billing', 'danger', apiErrorMessage(error));
  } finally {
    setBusy('billing-checkout', false);
    renderSubscriptionPanel();
  }
}

async function handleBillingPortal() {
  if (!isBillingManager() || !getWorkspaceSubscription().manageAvailable || isBusy('billing-portal')) return;
  setBusy('billing-portal', true);
  setStatus('billing', 'pending', 'Opening billing portal…');
  renderSubscriptionPanel();
  try {
    const result = await apiCall('POST', `/api/workspaces/${state.activeWorkspaceId}/billing/portal`);
    if (result?.url) {
      window.location.href = result.url;
      return;
    }
    throw new Error('Billing portal URL was not returned.');
  } catch (error) {
    setStatus('billing', 'danger', apiErrorMessage(error));
  } finally {
    setBusy('billing-portal', false);
    renderSubscriptionPanel();
  }
}

function isUserInteracting() {
  const activeEl = document.activeElement;
  const isEditing = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT');
  const hasPendingThumbnail = Object.keys(state.youtubeThumbnailFiles).some((key) => state.youtubeThumbnailFiles[key] !== null);
  return !!(isEditing || hasPendingThumbnail || state.ui.modal.open);
}

function handleRefreshClick() {
  hideAlert();
  setStatus('channels', 'pending', 'Refreshing workspace state…');
  setBusy('portal-refresh', true);
  Promise.resolve(loadWorkspaceData()).finally(() => setBusy('portal-refresh', false));
}

function setupEventListeners() {
  if (state.listenersBound) return;
  state.listenersBound = true;

  window.addEventListener('focus', () => {
    if (document.visibilityState === 'visible' && state.user && state.activeWorkspaceId && !isUserInteracting()) {
      return loadWorkspaceData({ silent: true });
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user && state.activeWorkspaceId && !isUserInteracting()) {
      return loadWorkspaceData({ silent: true });
    }
  });

  setInterval(() => {
    if (document.visibilityState === 'visible' && state.user && state.activeWorkspaceId && !isUserInteracting()) {
      loadWorkspaceData({ silent: true });
    }
  }, 10000);

  document.getElementById('auth-toggle-link').addEventListener('click', (event) => {
    event.preventDefault();
    state.isRegisterMode = !state.isRegisterMode;
    renderAuthView();
  });

  document.getElementById('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const generation = ++state.ui.authGeneration;
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;
    const alertEl = document.getElementById('auth-alert');
    const submitButton = document.getElementById('auth-submit-btn');
    const idleLabel = submitButton.textContent;
    const controller = trackAbort();
    alertEl.style.display = 'none';
    try {
      if (state.isRegisterMode) {
        const workspaceName = document.getElementById('reg-workspace').value;
        if (!workspaceName) throw new Error('Workspace name is required for registration.');
      }
      submitButton.disabled = true;
      submitButton.textContent = state.isRegisterMode ? 'Creating workspace…' : 'Signing in…';
      state.ui.authPending = true;
      syncLoader();
      if (state.isRegisterMode) {
        const workspaceName = document.getElementById('reg-workspace').value;
        await apiCall('POST', '/api/auth/register', { email, password, workspaceName }, { signal: controller.signal });
      } else {
        await apiCall('POST', '/api/auth/login', { email, password }, { signal: controller.signal });
      }
      if (generation !== state.ui.authGeneration) return;
      await init();
    } catch (error) {
      if (generation !== state.ui.authGeneration || error?.name === 'AbortError') return;
      alertEl.textContent = error.message;
      alertEl.style.display = 'block';
    } finally {
      releaseAbort(controller);
      if (generation !== state.ui.authGeneration) return;
      state.ui.authPending = false;
      syncLoader();
      submitButton.disabled = false;
      submitButton.textContent = idleLabel;
    }
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    const controller = trackAbort();
    setBusy('logout', true);
    try { await apiCall('POST', '/api/auth/logout', null, { signal: controller.signal }); } catch (_) {}
    finally { releaseAbort(controller); setBusy('logout', false); }
    state.user = null;
    state.workspaces = [];
    state.activeWorkspaceId = null;
    state.activeWorkspace = null;
    state.activeWorkspaceRole = '';
    clearBillingReturnFlow();
    state.billing.workspace = null;
    state.billing.summaryError = '';
    state.billing.stickyNotice = null;
    state.providers = {};
    state.providerTargets = [];
    state.customTargets = [];
    state.setup = { ingestServer: '', devices: [], stream: null, destinations: [] };
    state.selectedDeviceId = '';
    state.selectedYoutubeTargetId = '';
    state.youtubeBroadcasts = {};
    state.youtubeBroadcastSelections = {};
    state.youtubeThumbnailFiles = {};
    state.ingestCredentials = null;
    state.linkCode = null;
    state.bulkResults = [];
    state.drafts = {
      customTarget: { name: '', stream_url: '', stream_key: '' },
      youtubeCreate: {
        title: '',
        description: '',
        privacyStatus: 'private',
        scheduledStartTime: '',
        latencyPreference: 'normal',
        categoryId: ''
      },
      youtubeUpdate: {
        title: '',
        description: '',
        privacyStatus: 'private',
        latencyPreference: 'normal',
        categoryId: ''
      },
      youtubeBulk: {
        title: '',
        description: '',
        privacyStatus: 'private',
        latencyPreference: 'normal',
        categoryId: '',
        targetIds: []
      }
    };
    state.ui.busy = {};
    state.ui.authPending = false;
    state.ui.sessionChecking = false;
    state.ui.statuses = {};
    state.ui.lastLoadedAt = null;
    showView('auth');
    syncLoader();
  });

  window.addEventListener('hashchange', () => {
    if (!state.user) return;
    setActiveView(activeViewFromLocation(), { skipHash: true });
  });

  document.getElementById('refresh-portal-btn').addEventListener('click', handleRefreshClick);

  document.addEventListener('input', (event) => {
    if (event.target.matches('[data-draft-section]')) updateDraftFromInput(event.target);
  });

  document.addEventListener('change', async (event) => {
    const target = event.target;
    if (target.id === 'encoder-device-select') {
      state.selectedDeviceId = target.value;
      renderEncoderPanel();
      renderDevicesPanel();
      return;
    }
    if (target.matches('[data-action="thumbnail-input"]')) {
      const targetId = target.dataset.targetId;
      state.youtubeThumbnailFiles[targetId] = target.files?.[0] || null;
      setStatus('youtube-update', target.files?.[0] ? 'success' : 'muted', target.files?.[0] ? `${target.files[0].name} ready to upload.` : 'No thumbnail selected.');
      renderYouTubeStudio();
      return;
    }
    if (target.matches('[data-action="toggle-provider-target"]')) {
      toggleDestinationSelection(target.dataset.targetId, target.checked);
      return;
    }
    if (target.matches('[data-action="toggle-custom-target"]')) {
      toggleDestinationSelection(target.dataset.targetId, target.checked);
      return;
    }
    if (target.matches('[data-action="toggle-bulk-target"]')) {
      const targetId = target.dataset.targetId;
      if (target.checked) {
        if (!state.drafts.youtubeBulk.targetIds.includes(targetId)) state.drafts.youtubeBulk.targetIds.push(targetId);
      } else {
        state.drafts.youtubeBulk.targetIds = state.drafts.youtubeBulk.targetIds.filter((id) => id !== targetId);
      }
      renderYouTubeStudio();
      return;
    }
    if (target.matches('[data-action="pick-broadcast-radio"]')) {
      const activeTarget = selectedYoutubeTarget();
      if (activeTarget) {
        state.youtubeBroadcastSelections[activeTarget.id] = target.value;
        hydrateDraftsFromBroadcast(selectedYoutubeBroadcast());
        renderYouTubeStudio();
      }
    }
  });

  document.addEventListener('submit', (event) => {
    if (event.target.id === 'pairing-code-form') {
      event.preventDefault();
      handleGeneratePairingCode(event.target);
    }
    if (event.target.id === 'custom-target-form') {
      event.preventDefault();
      handleCreateCustomTarget(event.target);
    }
    if (event.target.id === 'youtube-create-form') {
      event.preventDefault();
      handleCreateBroadcast(event.target);
    }
    if (event.target.id === 'youtube-update-form') {
      event.preventDefault();
      handleUpdateBroadcast(event.target);
    }
    if (event.target.id === 'youtube-bulk-form') {
      event.preventDefault();
      handleBulkUpdate(event.target);
    }
  });

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action], [data-modal-action], #portal-modal-close');
    if (!button) return;

    if (button.id === 'portal-modal-close') {
      closeModal(false);
      return;
    }
    if (button.dataset.modalAction === 'confirm') {
      closeModal(true);
      return;
    }
    if (button.dataset.modalAction === 'cancel') {
      closeModal(false);
      return;
    }

    const action = button.dataset.action;
    if (action === 'open-view') {
      setActiveView(button.dataset.view);
      return;
    }
    if (action === 'copy-ingest-server') copyText(state.setup.ingestServer, 'RTMP URL copied.', 'encoder');
    if (action === 'toggle-new-key-visibility' && state.ingestCredentials) {
      state.ingestCredentials.revealed = !state.ingestCredentials.revealed;
      renderEncoderPanel();
    }
    if (action === 'copy-new-key' && state.ingestCredentials) copyText(state.ingestCredentials.streamKey, 'New OBS key copied.', 'encoder');
    if (action === 'dismiss-new-key') {
      state.ingestCredentials = null;
      renderEncoderPanel();
    }
    if (action === 'rotate-ingest-key') handleRotateIngestKey(button.dataset.deviceId);
    if (action === 'revoke-device') handleRevokeDevice(button.dataset.deviceId);
    if (action === 'select-device') {
      state.selectedDeviceId = button.dataset.deviceId;
      renderEncoderPanel();
      renderDevicesPanel();
    }
    if (action === 'copy-link-code' && state.linkCode) copyText(state.linkCode.code, 'Pairing code copied.', 'devices');
    if (action === 'connect-provider') handleConnectProvider(button.dataset.provider);
    if (action === 'disconnect-provider') handleDisconnectProvider(button.dataset.provider);
    if (action === 'delete-custom-target') handleDeleteCustomTarget(button.dataset.targetId);
    if (action === 'select-youtube-target') {
      state.selectedYoutubeTargetId = button.dataset.targetId;
      setBusy('youtube-target', true);
      try {
        await ensureYoutubeBroadcasts(state.selectedYoutubeTargetId, { silent: true });
        hydrateDraftsFromBroadcast(selectedYoutubeBroadcast());
        renderYouTubeStudio();
      } finally {
        setBusy('youtube-target', false);
      }
    }
    if (action === 'refresh-broadcasts') await ensureYoutubeBroadcasts(button.dataset.targetId, { force: true });
    if (action === 'select-broadcast') handleSelectBroadcast(button.dataset.targetId, button.dataset.broadcastId);
    if (action === 'upload-thumbnail') handleUploadThumbnail(button.dataset.targetId);
    if (action === 'transition-broadcast') handleTransitionBroadcast(button.dataset.targetId, button.dataset.status);
    if (action === 'billing-checkout') handleBillingCheckout();
    if (action === 'billing-portal') handleBillingPortal();
    if (action === 'billing-manual-retry') {
      setBusy('billing-verify', true);
      try { await verifyBillingReturn({ manualOnly: true }); }
      finally { setBusy('billing-verify', false); }
    }
    if (action === 'billing-dismiss-return' && !state.billing.returnFlow?.checking) {
      clearBillingReturnFlow();
      clearStatus('billing');
      renderSubscriptionPanel();
    }
  });

  modalBackdrop().addEventListener('click', (event) => {
    if (event.target === modalBackdrop()) closeModal(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.ui.modal.open) {
      closeModal(false);
      return;
    }
    trapModalFocus(event);
  });

  window.addEventListener('pagehide', () => {
    state.ui.sessionChecking = false;
    state.ui.authPending = false;
    clearStartupHold();
    abortTracked();
    syncLoader();
  });

  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    state.ui.sessionChecking = false;
    state.ui.authPending = false;
    syncLoader();
  });
}

async function init() {
  primeBillingReturnFlowFromLocation();
  setupEventListeners();
  const sessionAbort = trackAbort();
  beginStartupHold();
  state.ui.sessionChecking = true;
  syncLoader();
  window.__emberstageBackdrop?.start();
  try {
    await configureProductAuth();
    if (sessionAbort.signal.aborted) return;
    const meData = await apiCall('GET', '/api/auth/me', null, { signal: sessionAbort.signal });
    if (sessionAbort.signal.aborted) return;
    if (meData?.success) {
      state.user = meData.user;
      const wsData = await apiCall('GET', '/api/workspaces', null, { signal: sessionAbort.signal });
      if (sessionAbort.signal.aborted) return;
      if (wsData?.workspaces?.length) {
        state.workspaces = wsData.workspaces;
        state.activeWorkspaceId = wsData.workspaces[0].id;
        showView('app');
        hideAlert();
        setBusy('portal-open', true);
        try {
          await loadWorkspaceData();
        } finally {
          setBusy('portal-open', false);
        }
        await resumeBillingReturnFlowIfNeeded();
      } else {
        showView('auth');
      }
    } else {
      showView('auth');
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    showView('auth');
  } finally {
    releaseAbort(sessionAbort);
    state.ui.sessionChecking = false;
    finishStartupPresentation();
  }
}

document.addEventListener('DOMContentLoaded', init);

const ANIMATION_33_SOURCE_SHA256 = 'ec82cbb75876c0ca981b0b1ae2ed9c1eba0135c533b8d1feab971ae20ed04fcc';
const BACKDROP_MAX_EDGE = 1280;

const vs = `attribute vec2 a_position;
varying vec2 v_texCoord;
void main() {
  v_texCoord = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;
  const fs = `precision highp float;

uniform float u_time;
uniform vec2 u_resolution;
uniform vec2 u_mouse;
varying vec2 v_texCoord;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = rot * p * 2.0;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = v_texCoord;
  vec2 aspect = vec2(u_resolution.x / max(u_resolution.y, 1.0), 1.0);
  vec2 p = (uv - 0.5) * aspect;

  float t = u_time * 0.12;
  vec2 mouseNorm = (u_mouse / max(u_resolution, vec2(1.0))) - 0.5;

  float q = fbm(p * 1.6 + vec2(t * 0.6, -t * 0.4));
  float r = fbm(p * 2.2 + vec2(q + t * 0.3, -q + t * 0.5) + mouseNorm * 0.15);

  vec3 obsidianDeep = vec3(0.039, 0.059, 0.078);
  vec3 obsidianMid  = vec3(0.075, 0.102, 0.135);
  vec3 emberOrange  = vec3(1.0, 0.333, 0.0);
  vec3 emberAmber   = vec3(1.0, 0.55, 0.1);

  vec3 col = mix(obsidianDeep, obsidianMid, smoothstep(0.2, 0.8, r));

  // Subtle flowing ember aura
  float emberMask = smoothstep(0.52, 0.88, r) * smoothstep(0.95, 0.15, length(p * 0.85));
  col += emberOrange * emberMask * 0.18;
  col += emberAmber * pow(emberMask, 2.0) * 0.10;

  // Soft vignette
  float vignette = smoothstep(1.25, 0.25, length(p));
  col *= mix(0.65, 1.0, vignette);

  gl_FragColor = vec4(col, 1.0);
}`;

function backdropReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

function mountPortalBackdrop() {
  const root = document.querySelector('.portal-backdrop');
  const canvas = document.getElementById('portal-backdrop-canvas');
  if (!root || !canvas || canvas.dataset.bound === '1') return;
  canvas.dataset.bound = '1';
  canvas.setAttribute('aria-hidden', 'true');

  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' })
    || canvas.getContext('experimental-webgl');
  if (!gl) return;

  function compile(type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const program = gl.createProgram();
  const vertex = compile(gl.VERTEX_SHADER, vs);
  const fragment = compile(gl.FRAGMENT_SHADER, fs);
  if (!program || !vertex || !fragment) return;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uTime = gl.getUniformLocation(program, 'u_time');
  const uRes = gl.getUniformLocation(program, 'u_resolution');
  const uMouse = gl.getUniformLocation(program, 'u_mouse');
  let mouse = { x: 0, y: 0 };
  let frame = 0;
  let running = false;

  function drawingSize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.max(1, Math.min(BACKDROP_MAX_EDGE, Math.round((rect.width || 1280) * dpr)));
    const height = Math.max(1, Math.min(BACKDROP_MAX_EDGE, Math.round((rect.height || 720) * dpr)));
    return { width, height };
  }

  function syncSize() {
    const size = drawingSize();
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width;
      canvas.height = size.height;
      mouse = { x: canvas.width / 2, y: canvas.height / 2 };
    }
  }

  function draw(timeMs) {
    if (gl.isContextLost()) return stop();
    syncSize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    if (uTime) gl.uniform1f(uTime, timeMs * 0.001);
    if (uRes) gl.uniform2f(uRes, canvas.width, canvas.height);
    if (uMouse) gl.uniform2f(uMouse, mouse.x, mouse.y);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function tick(timeMs) {
    frame = 0;
    if (!running) return;
    draw(timeMs);
    frame = window.requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
  }

  function start() {
    if (running || backdropReducedMotion() || document.hidden || gl.isContextLost()) return;
    running = true;
    frame = window.requestAnimationFrame(tick);
  }

  function onPointer(event) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const nx = (event.clientX - rect.left) / rect.width;
    const ny = 1 - ((event.clientY - rect.top) / rect.height);
    mouse.x = nx * canvas.width;
    mouse.y = ny * canvas.height;
  }

  window.addEventListener('pointermove', onPointer, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else start();
  });
  window.addEventListener('pagehide', stop);
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    stop();
    root.classList.remove('is-shader');
  }, false);

  root.classList.add('is-shader');
  syncSize();
  draw(0);
  if (!backdropReducedMotion()) start();
  window.__emberstageBackdrop = {
    start,
    stop,
    draw,
    sourceSha256: ANIMATION_33_SOURCE_SHA256,
    maxEdge: BACKDROP_MAX_EDGE
  };
}

document.addEventListener('DOMContentLoaded', mountPortalBackdrop);
