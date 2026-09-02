import type { CapturableApp, GuildConfigStatus, StreamingStatus, VoiceChannelInfo } from '../shared/types';
// Renderer modules are loaded by Chromium's native ES module loader (no
// bundler -- see index.html's `<script type="module">`), which requires
// the full file extension on a relative specifier; `moduleResolution:
// "Node"` (tsconfig.base.json) still resolves this `.js` specifier against
// the sibling `.ts` source file at compile time.
import { GUIDE_HTML } from './guideContent.generated.js';

// Temporary diagnostics: uncaught exceptions and unhandled promise
// rejections don't reach the main process' `console-message` listener on
// their own (that only mirrors explicit console.* calls) -- forward them
// explicitly so the real stack trace shows up in the terminal instead of
// only as a rendered message in the UI.
window.addEventListener('error', (event) => {
  console.error('[renderer:uncaught]', event.message, event.error?.stack ?? '(no stack)');
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[renderer:unhandledrejection]', event.reason);
});
console.log('[renderer:diagnostic] typeof window.bard =', typeof window.bard);

const bard = window.bard;

// `localStorage` here is per-userData-profile already (each packaged/dev
// install gets its own), so it's a fine, simple place for pure UI
// convenience state that isn't part of the app's real config
// (src/main/config.ts) and doesn't need to be visible to the main process.
const STORAGE_KEYS = {
  selectedAppId: 'bard.selectedAppId',
  selectedChannelId: 'bard.selectedChannelId',
} as const;

const APP_LIST_REFRESH_INTERVAL_MS = 4500;

let apps: CapturableApp[] = [];
let selectedAppId: string | null = localStorage.getItem(STORAGE_KEYS.selectedAppId);

let voiceChannels: VoiceChannelInfo[] = [];
// Last channel the user successfully joined, restored across restarts. This
// is shown as a "last used" hint on the matching list item, not
// auto-rejoined -- joining a voice channel is a real network action, and a
// picker click is the only thing that ever triggers it (see the running-app
// picker for the same "restore the visual selection, never auto-act" idea).
let lastUsedChannelId: string | null = localStorage.getItem(STORAGE_KEYS.selectedChannelId);

const els = {
  botSetupSteps: document.getElementById('bot-setup-steps') as HTMLElement,
  tokenInput: document.getElementById('token-input') as HTMLInputElement,
  tokenSaveBtn: document.getElementById('token-save-btn') as HTMLButtonElement,
  tokenStatus: document.getElementById('token-status') as HTMLElement,
  tokenError: document.getElementById('token-error') as HTMLElement,
  botConnectedView: document.getElementById('bot-connected-view') as HTMLElement,
  botUsernameDisplay: document.getElementById('bot-username-display') as HTMLElement,
  inviteLink: document.getElementById('invite-link') as HTMLAnchorElement,
  copyInviteBtn: document.getElementById('copy-invite-btn') as HTMLButtonElement,
  inviteStatus: document.getElementById('invite-status') as HTMLElement,
  changeTokenBtn: document.getElementById('change-token-btn') as HTMLButtonElement,
  botConnected: document.getElementById('bot-connected') as HTMLElement,
  botUsername: document.getElementById('bot-username') as HTMLElement,
  statusGuild: document.getElementById('status-guild') as HTMLElement,
  statusChannel: document.getElementById('status-channel') as HTMLElement,
  refreshBtn: document.getElementById('refresh-btn') as HTMLButtonElement,
  appFilterInput: document.getElementById('app-filter-input') as HTMLInputElement,
  appList: document.getElementById('app-list') as HTMLUListElement,
  appListEmpty: document.getElementById('app-list-empty') as HTMLElement,
  appListFilteredEmpty: document.getElementById('app-list-filtered-empty') as HTMLElement,
  statusStateDot: document.getElementById('status-state-dot') as HTMLElement,
  statusStateText: document.getElementById('status-state-text') as HTMLElement,
  statusApp: document.getElementById('status-app') as HTMLElement,
  statusError: document.getElementById('status-error') as HTMLElement,
  startBtn: document.getElementById('start-btn') as HTMLButtonElement,
  stopBtn: document.getElementById('stop-btn') as HTMLButtonElement,

  guildIdInput: document.getElementById('guild-id-input') as HTMLInputElement,
  guildSaveBtn: document.getElementById('guild-save-btn') as HTMLButtonElement,
  guildStatus: document.getElementById('guild-status') as HTMLElement,
  guildStatusDot: document.getElementById('guild-status-dot') as HTMLElement,
  guildStatusText: document.getElementById('guild-status-text') as HTMLElement,
  guildError: document.getElementById('guild-error') as HTMLElement,
  guildChannelList: document.getElementById('guild-channel-list') as HTMLUListElement,

  helpBtn: document.getElementById('help-btn') as HTMLButtonElement,
  helpModalOverlay: document.getElementById('help-modal-overlay') as HTMLElement,
  helpModal: document.getElementById('help-modal') as HTMLElement,
  helpModalCloseBtn: document.getElementById('help-modal-close-btn') as HTMLButtonElement,
  helpModalContent: document.getElementById('help-modal-content') as HTMLElement,
};

/** Sets `text` on `el` with a CSS fade-out animation, restarting the
 * animation even if it's already mid-flight (e.g. two quick saves in a
 * row) -- forcing a reflow between removing and re-adding the class is
 * the standard way to restart a CSS animation from JS. */
function flashSuccess(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.classList.remove('flash-success');
  void el.offsetWidth;
  el.classList.add('flash-success');
}

function makeListItemFocusable(li: HTMLLIElement): void {
  li.tabIndex = 0;
  li.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      li.click();
    }
  });
}

/** Case-insensitive match against either the display name or the raw
 * process/binary name, so filtering works whether the user remembers the
 * app's friendly name ("Discord") or its executable ("discord"). */
function filteredApps(): CapturableApp[] {
  const query = els.appFilterInput.value.trim().toLowerCase();
  if (query.length === 0) return apps;
  return apps.filter(
    (app) => app.name.toLowerCase().includes(query) || app.processName.toLowerCase().includes(query),
  );
}

function renderAppList(): void {
  els.appList.innerHTML = '';
  const visible = filteredApps();

  els.appListEmpty.hidden = apps.length > 0;
  els.appListFilteredEmpty.hidden = apps.length === 0 || visible.length > 0;

  for (const app of visible) {
    const li = document.createElement('li');
    li.role = 'option';
    li.setAttribute('aria-selected', String(app.id === selectedAppId));
    li.classList.toggle('selected', app.id === selectedAppId);
    makeListItemFocusable(li);

    const name = document.createElement('span');
    name.className = 'app-name';
    name.textContent = app.name;

    const proc = document.createElement('span');
    proc.className = 'app-process';
    proc.textContent = app.processName;

    li.append(name, proc);
    li.addEventListener('click', () => {
      selectedAppId = app.id;
      localStorage.setItem(STORAGE_KEYS.selectedAppId, app.id);
      renderAppList();
      updateStartStopEnabled();
    });

    els.appList.appendChild(li);
  }
}

function updateStartStopEnabled(): void {
  els.startBtn.disabled = selectedAppId === null;
}

function describeStreamingState(status: StreamingStatus): string {
  if (status.state === 'waiting_for_audio') {
    return `Waiting for ${status.selectedApp?.name ?? 'app'} to play audio...`;
  }
  return status.state;
}

/** One consistent dot language across every card: muted = idle/unknown,
 * amber (pulsing while in progress) = action needed or connecting,
 * green = healthy/live, red = error. */
function streamingStateDotClass(state: StreamingStatus['state']): string {
  switch (state) {
    case 'live':
      return 'status-dot status-dot--ok';
    case 'connecting':
    case 'waiting_for_audio':
      return 'status-dot status-dot--warning status-dot--pulse';
    case 'error':
      return 'status-dot status-dot--error';
    case 'idle':
    default:
      return 'status-dot status-dot--muted';
  }
}

function renderStreamingStatus(status: StreamingStatus): void {
  els.statusStateText.textContent = describeStreamingState(status);
  els.statusStateDot.className = streamingStateDotClass(status.state);
  els.statusApp.textContent = status.selectedApp?.name ?? 'none';
  els.statusGuild.textContent = status.guildName ?? 'not connected';
  els.statusChannel.textContent = status.channelName ?? 'not connected';

  if (status.errorMessage) {
    els.statusError.hidden = false;
    els.statusError.textContent = status.errorMessage;
  } else {
    els.statusError.hidden = true;
    els.statusError.textContent = '';
  }

  els.stopBtn.disabled =
    status.state !== 'live' && status.state !== 'connecting' && status.state !== 'waiting_for_audio';
  els.startBtn.disabled =
    selectedAppId === null || status.state === 'connecting' || status.state === 'waiting_for_audio';
}

async function refreshApps(): Promise<void> {
  els.refreshBtn.disabled = true;
  try {
    apps = await bard.listApps();
    if (selectedAppId && !apps.some((a) => a.id === selectedAppId)) {
      selectedAppId = null;
    }
    renderAppList();
    updateStartStopEnabled();
  } catch (err) {
    els.statusError.hidden = false;
    els.statusError.textContent = `Failed to list applications: ${(err as Error).message}`;
  } finally {
    els.refreshBtn.disabled = false;
  }
}

/** Clears the inline token-error paragraph (step 2 of the wizard). */
function clearTokenError(): void {
  els.tokenError.hidden = true;
  els.tokenError.textContent = '';
}

function showTokenError(message: string): void {
  els.tokenStatus.textContent = '';
  els.tokenError.hidden = false;
  els.tokenError.textContent = message;
}

async function refreshBotSetupStatus(): Promise<void> {
  const setup = await bard.getBotSetupStatus();
  els.botConnected.textContent = setup.connected ? 'yes' : 'no';
  els.botConnected.classList.toggle('value-ok', setup.connected);
  els.botConnected.classList.toggle('value-muted', !setup.connected);
  els.botUsername.textContent = setup.botUsername ?? '-';

  // Steps 1-2 (create bot, paste token) show whenever the bot isn't
  // connected -- including right after a failed save, so a bad token
  // never leaves the user stuck with no way to retry (see "Change token"
  // for the deliberate-swap case, and this for the failure case). Step 3
  // (connected view) shows only once actually connected.
  els.botSetupSteps.hidden = setup.connected;
  els.botConnectedView.hidden = !setup.connected;

  if (setup.connected) {
    clearTokenError();
    els.botUsernameDisplay.textContent = setup.botUsername ?? '-';
    if (setup.inviteUrl) {
      els.inviteLink.href = setup.inviteUrl;
      els.inviteLink.classList.remove('disabled-link');
    } else {
      els.inviteLink.href = '#';
      els.inviteLink.classList.add('disabled-link');
    }
    els.copyInviteBtn.disabled = !setup.inviteUrl;
  } else if (setup.connectError) {
    // Explains an otherwise-silent "not connected" state -- e.g. a stored
    // token that was revoked while the app was closed.
    showTokenError(setup.connectError);
  }
}

async function handleSaveToken(): Promise<void> {
  const token = els.tokenInput.value;
  els.tokenSaveBtn.disabled = true;
  els.tokenStatus.classList.remove('flash-success');
  els.tokenStatus.textContent = 'Connecting to Discord...';
  clearTokenError();
  try {
    const result = await bard.saveBotToken(token);
    if (result.ok) {
      els.tokenInput.value = '';
      flashSuccess(els.tokenStatus, 'Connected.');
      await refreshBotSetupStatus();
    } else {
      showTokenError(result.errorMessage ?? 'Failed to save token.');
    }
  } catch (err) {
    // Defensive: an actual unhandled IPC-layer rejection should never
    // reach here now that SAVE_BOT_TOKEN always resolves with ok/errorMessage,
    // but this is the fix for the bug where a rejected promise used to be
    // silently swallowed (no catch block) and left "Saving..." on screen forever.
    showTokenError(`Failed to save token: ${(err as Error).message}`);
  } finally {
    els.tokenSaveBtn.disabled = false;
  }
}

async function handleCopyInvite(): Promise<void> {
  els.copyInviteBtn.disabled = true;
  els.inviteStatus.classList.remove('flash-success');
  try {
    const result = await bard.copyInviteLink();
    if (result.ok) {
      flashSuccess(els.inviteStatus, 'Invite link copied.');
    } else {
      els.inviteStatus.textContent = result.errorMessage ?? 'Failed to copy invite link.';
    }
  } catch (err) {
    els.inviteStatus.textContent = `Failed to copy invite link: ${(err as Error).message}`;
  } finally {
    els.copyInviteBtn.disabled = false;
  }
}

async function handleChangeToken(): Promise<void> {
  els.changeTokenBtn.disabled = true;
  try {
    await bard.clearBotToken();
    els.tokenStatus.classList.remove('flash-success');
    els.tokenStatus.textContent = '';
    clearTokenError();
    await refreshBotSetupStatus();
  } finally {
    els.changeTokenBtn.disabled = false;
  }
}

async function handleStart(): Promise<void> {
  if (!selectedAppId) return;
  els.startBtn.disabled = true;
  const result = await bard.startStreaming(selectedAppId);
  if (!result.ok) {
    els.statusError.hidden = false;
    els.statusError.textContent = result.errorMessage ?? 'Failed to start streaming.';
  }
}

async function handleStop(): Promise<void> {
  els.stopBtn.disabled = true;
  await bard.stopStreaming();
}

function showGuildError(message: string): void {
  els.guildError.hidden = false;
  els.guildError.textContent = message;
}

function clearGuildError(): void {
  els.guildError.hidden = true;
  els.guildError.textContent = '';
}

async function handleJoinGuildChannel(channelId: string, li: HTMLLIElement): Promise<void> {
  clearGuildError();
  li.classList.add('joining');
  try {
    const result = await bard.joinGuildVoiceChannel(channelId);
    if (result.ok) {
      lastUsedChannelId = channelId;
      localStorage.setItem(STORAGE_KEYS.selectedChannelId, channelId);
      renderGuildChannelList(voiceChannels);
    } else {
      showGuildError(result.errorMessage ?? 'Failed to join voice channel.');
    }
  } catch (err) {
    showGuildError(`Failed to join voice channel: ${(err as Error).message}`);
  } finally {
    li.classList.remove('joining');
  }
}

function renderGuildChannelList(channels: VoiceChannelInfo[]): void {
  voiceChannels = channels;
  els.guildChannelList.innerHTML = '';
  els.guildChannelList.hidden = channels.length === 0;

  for (const channel of channels) {
    const li = document.createElement('li');
    li.role = 'option';
    li.setAttribute('aria-selected', 'false');
    makeListItemFocusable(li);

    const name = document.createElement('span');
    name.className = 'app-name';
    // Prefix with the parent category name when there is one -- two
    // channels (even across different servers) can easily share the exact
    // same generic name (e.g. "Canal de Voz"), and the category is the
    // distinguishing context the user actually recognizes.
    name.textContent = channel.categoryName ? `${channel.categoryName} - ${channel.name}` : channel.name;
    li.appendChild(name);

    // Secondary/trailing group: the channel's raw id (always shown, in
    // monospace, muted -- same primary-name + secondary-muted-text pattern
    // as the running-app picker's app-name/app-process) covers the rarer
    // case of two identically-named channels in the very same category,
    // where the category prefix alone can't disambiguate. Grouped with the
    // "Last used" tag so the row keeps exactly two flex children for
    // `space-between` (name on the left, this group on the right).
    const meta = document.createElement('span');
    meta.className = 'app-list-meta';

    const id = document.createElement('span');
    id.className = 'app-process channel-id';
    id.textContent = channel.id;
    meta.appendChild(id);

    if (channel.id === lastUsedChannelId) {
      const tag = document.createElement('span');
      tag.className = 'last-used-tag';
      tag.textContent = 'Last used';
      meta.appendChild(tag);
    }

    li.appendChild(meta);

    li.addEventListener('click', () => void handleJoinGuildChannel(channel.id, li));
    els.guildChannelList.appendChild(li);
  }
}

function guildStateDotClass(state: GuildConfigStatus['state']): string {
  switch (state) {
    case 'resolved':
      return 'status-dot status-dot--ok';
    case 'not_a_member':
      return 'status-dot status-dot--warning';
    case 'not_configured':
    default:
      return 'status-dot status-dot--muted';
  }
}

function renderGuildConfigStatus(status: GuildConfigStatus): void {
  clearGuildError();
  els.guildStatusText.classList.remove('flash-success');
  els.guildStatusDot.className = guildStateDotClass(status.state);

  switch (status.state) {
    case 'not_configured':
      els.guildStatusText.textContent = 'Not configured.';
      renderGuildChannelList([]);
      break;
    case 'not_a_member':
      els.guildStatusText.textContent = `Configured server (${status.guildId}) not found -- make sure the bot has been invited to it.`;
      renderGuildChannelList([]);
      break;
    case 'resolved':
      els.guildStatusText.textContent = `Connected to ${status.guildName}.`;
      renderGuildChannelList(status.voiceChannels);
      break;
  }
}

async function handleSaveGuildId(): Promise<void> {
  const guildId = els.guildIdInput.value;
  els.guildSaveBtn.disabled = true;
  clearGuildError();
  try {
    const result = await bard.saveGuildId(guildId);
    if (result.ok) {
      els.guildIdInput.value = '';
      flashSuccess(els.guildStatusText, 'Saved.');
      els.guildStatusDot.className = 'status-dot status-dot--ok';
      setTimeout(() => void bard.getGuildConfig().then(renderGuildConfigStatus), 900);
    } else {
      showGuildError(result.errorMessage ?? 'Failed to save guild id.');
    }
  } finally {
    els.guildSaveBtn.disabled = false;
  }
}

/** Element that had focus right before the help modal opened, so it can be
 * restored on close (same "don't strand keyboard focus" care as the rest of
 * this app's keyboard-accessibility effort). */
let helpModalOpener: HTMLElement | null = null;

function onHelpModalKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeHelpModal();
  }
}

function openHelpModal(): void {
  helpModalOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  els.helpModalOverlay.hidden = false;
  els.helpModal.focus();
  document.addEventListener('keydown', onHelpModalKeydown);
}

function closeHelpModal(): void {
  els.helpModalOverlay.hidden = true;
  document.removeEventListener('keydown', onHelpModalKeydown);
  helpModalOpener?.focus();
  helpModalOpener = null;
}

function onEnterKey(input: HTMLInputElement, action: () => void): void {
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      action();
    }
  });
}

function wireEvents(): void {
  els.refreshBtn.addEventListener('click', () => void refreshApps());
  els.appFilterInput.addEventListener('input', () => renderAppList());
  els.tokenSaveBtn.addEventListener('click', () => void handleSaveToken());
  els.copyInviteBtn.addEventListener('click', () => void handleCopyInvite());
  els.changeTokenBtn.addEventListener('click', () => void handleChangeToken());
  els.startBtn.addEventListener('click', () => void handleStart());
  els.stopBtn.addEventListener('click', () => void handleStop());
  bard.onStatusChanged(renderStreamingStatus);

  els.guildSaveBtn.addEventListener('click', () => void handleSaveGuildId());
  bard.onGuildConfigChanged(renderGuildConfigStatus);

  onEnterKey(els.tokenInput, () => void handleSaveToken());
  onEnterKey(els.guildIdInput, () => void handleSaveGuildId());

  els.helpBtn.addEventListener('click', () => openHelpModal());
  els.helpModalCloseBtn.addEventListener('click', () => closeHelpModal());
  // Backdrop click: only close when the click actually landed on the
  // overlay itself, not on the panel or anything inside it.
  els.helpModalOverlay.addEventListener('click', (event) => {
    if (event.target === els.helpModalOverlay) closeHelpModal();
  });

  // Keep the running-app list fresh without a manual click every time. The
  // manual Refresh button still works on top of this for an explicit
  // immediate check; `refreshApps()` already preserves `selectedAppId`
  // whenever it's still present in the refreshed list.
  setInterval(() => void refreshApps(), APP_LIST_REFRESH_INTERVAL_MS);
}

async function init(): Promise<void> {
  wireEvents();

  // Safe to assign via innerHTML here specifically: GUIDE_HTML comes from
  // guideContent.generated.ts, produced at build time (scripts/build-guide.js)
  // from this project's own GETTING-STARTED.md -- developer-authored and
  // trusted, never fetched at runtime or influenced by user/network input.
  // This is NOT a general-purpose pattern for untrusted content.
  els.helpModalContent.innerHTML = GUIDE_HTML;

  await refreshBotSetupStatus();
  const status = await bard.getStatus();
  renderStreamingStatus(status);
  await refreshApps();
  renderGuildConfigStatus(await bard.getGuildConfig());
}

void init();
