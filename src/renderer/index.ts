import type { CapturableApp, ManageableGuild, OAuthLoginStatus, StreamingStatus } from '../shared/types';

const bard = window.bard;

let apps: CapturableApp[] = [];
let selectedAppId: string | null = null;

const els = {
  tokenSection: document.getElementById('token-section') as HTMLElement,
  tokenInput: document.getElementById('token-input') as HTMLInputElement,
  tokenSaveBtn: document.getElementById('token-save-btn') as HTMLButtonElement,
  tokenStatus: document.getElementById('token-status') as HTMLElement,
  botConnected: document.getElementById('bot-connected') as HTMLElement,
  botUsername: document.getElementById('bot-username') as HTMLElement,
  statusGuild: document.getElementById('status-guild') as HTMLElement,
  statusChannel: document.getElementById('status-channel') as HTMLElement,
  refreshBtn: document.getElementById('refresh-btn') as HTMLButtonElement,
  appList: document.getElementById('app-list') as HTMLUListElement,
  appListEmpty: document.getElementById('app-list-empty') as HTMLElement,
  statusState: document.getElementById('status-state') as HTMLElement,
  statusApp: document.getElementById('status-app') as HTMLElement,
  statusError: document.getElementById('status-error') as HTMLElement,
  startBtn: document.getElementById('start-btn') as HTMLButtonElement,
  stopBtn: document.getElementById('stop-btn') as HTMLButtonElement,

  oauthClientSection: document.getElementById('oauth-client-section') as HTMLElement,
  oauthClientIdInput: document.getElementById('oauth-client-id-input') as HTMLInputElement,
  oauthClientSecretInput: document.getElementById('oauth-client-secret-input') as HTMLInputElement,
  oauthClientSaveBtn: document.getElementById('oauth-client-save-btn') as HTMLButtonElement,
  oauthClientStatus: document.getElementById('oauth-client-status') as HTMLElement,
  oauthLoginBtn: document.getElementById('oauth-login-btn') as HTMLButtonElement,
  oauthLogoutBtn: document.getElementById('oauth-logout-btn') as HTMLButtonElement,
  oauthLoginStatus: document.getElementById('oauth-login-status') as HTMLElement,
  oauthLoginError: document.getElementById('oauth-login-error') as HTMLElement,
  guildList: document.getElementById('guild-list') as HTMLUListElement,
  guildListEmpty: document.getElementById('guild-list-empty') as HTMLElement,
};

function renderAppList(): void {
  els.appList.innerHTML = '';
  els.appListEmpty.hidden = apps.length > 0;

  for (const app of apps) {
    const li = document.createElement('li');
    li.role = 'option';
    li.setAttribute('aria-selected', String(app.id === selectedAppId));
    li.classList.toggle('selected', app.id === selectedAppId);

    const name = document.createElement('span');
    name.className = 'app-name';
    name.textContent = app.name;

    const proc = document.createElement('span');
    proc.className = 'app-process';
    proc.textContent = app.processName;

    li.append(name, proc);
    li.addEventListener('click', () => {
      selectedAppId = app.id;
      renderAppList();
      updateStartStopEnabled();
    });

    els.appList.appendChild(li);
  }
}

function updateStartStopEnabled(): void {
  els.startBtn.disabled = selectedAppId === null;
}

function renderStreamingStatus(status: StreamingStatus): void {
  els.statusState.textContent = status.state;
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

  els.stopBtn.disabled = status.state !== 'live' && status.state !== 'connecting';
  els.startBtn.disabled = selectedAppId === null || status.state === 'connecting';
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

async function refreshBotSetupStatus(): Promise<void> {
  const setup = await bard.getBotSetupStatus();
  els.tokenSection.hidden = setup.hasToken;
  els.botConnected.textContent = setup.connected ? 'yes' : 'no';
  els.botUsername.textContent = setup.botUsername ?? '-';
}

async function handleSaveToken(): Promise<void> {
  const token = els.tokenInput.value;
  els.tokenSaveBtn.disabled = true;
  els.tokenStatus.textContent = 'Saving...';
  try {
    const result = await bard.saveBotToken(token);
    if (result.ok) {
      els.tokenStatus.textContent = 'Token saved. Connecting...';
      els.tokenInput.value = '';
      await refreshBotSetupStatus();
    } else {
      els.tokenStatus.textContent = result.errorMessage ?? 'Failed to save token.';
    }
  } finally {
    els.tokenSaveBtn.disabled = false;
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

async function refreshOAuthClientStatus(): Promise<void> {
  const setup = await bard.getOAuthClientStatus();
  els.oauthClientSection.hidden = setup.hasClientCredentials;
}

async function handleSaveOAuthClient(): Promise<void> {
  const clientId = els.oauthClientIdInput.value;
  const clientSecret = els.oauthClientSecretInput.value;
  els.oauthClientSaveBtn.disabled = true;
  els.oauthClientStatus.textContent = 'Saving...';
  try {
    const result = await bard.saveOAuthClient(clientId, clientSecret);
    if (result.ok) {
      els.oauthClientStatus.textContent = 'Credentials saved.';
      els.oauthClientIdInput.value = '';
      els.oauthClientSecretInput.value = '';
      await refreshOAuthClientStatus();
    } else {
      els.oauthClientStatus.textContent = result.errorMessage ?? 'Failed to save credentials.';
    }
  } finally {
    els.oauthClientSaveBtn.disabled = false;
  }
}

function showOAuthError(message: string): void {
  els.oauthLoginError.hidden = false;
  els.oauthLoginError.textContent = message;
}

async function handleJoinGuildChannel(guildId: string, channelId: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  els.oauthLoginError.hidden = true;
  els.oauthLoginError.textContent = '';
  try {
    const result = await bard.joinGuildVoiceChannel(guildId, channelId);
    if (!result.ok) {
      showOAuthError(result.errorMessage ?? 'Failed to join voice channel.');
    }
  } catch (err) {
    showOAuthError(`Failed to join voice channel: ${(err as Error).message}`);
  } finally {
    btn.disabled = false;
  }
}

function renderGuildList(guilds: ManageableGuild[]): void {
  els.guildList.innerHTML = '';
  els.guildList.hidden = guilds.length === 0;
  els.guildListEmpty.hidden = guilds.length > 0;

  for (const guild of guilds) {
    const li = document.createElement('li');
    li.className = 'guild-item';

    const name = document.createElement('div');
    name.className = 'guild-name';
    name.textContent = guild.name;
    li.appendChild(name);

    const channelList = document.createElement('ul');
    channelList.className = 'channel-list';
    for (const channel of guild.voiceChannels) {
      const channelLi = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'channel-join-btn';
      btn.textContent = channel.name;
      btn.addEventListener('click', () => void handleJoinGuildChannel(guild.id, channel.id, btn));
      channelLi.appendChild(btn);
      channelList.appendChild(channelLi);
    }
    li.appendChild(channelList);

    els.guildList.appendChild(li);
  }
}

async function refreshManageableGuilds(): Promise<void> {
  try {
    const guilds = await bard.listManageableGuilds();
    renderGuildList(guilds);
  } catch (err) {
    showOAuthError(`Failed to list servers: ${(err as Error).message}`);
  }
}

function renderOAuthLoginStatus(status: OAuthLoginStatus): void {
  els.oauthLoginError.hidden = true;
  els.oauthLoginError.textContent = '';

  switch (status.state) {
    case 'idle':
      els.oauthLoginStatus.textContent = 'Not signed in.';
      els.oauthLoginBtn.hidden = false;
      els.oauthLoginBtn.disabled = false;
      els.oauthLogoutBtn.hidden = true;
      renderGuildList([]);
      break;
    case 'waiting_for_browser':
      els.oauthLoginStatus.textContent = 'Waiting for browser...';
      els.oauthLoginBtn.disabled = true;
      break;
    case 'exchanging':
      els.oauthLoginStatus.textContent = 'Signing in...';
      els.oauthLoginBtn.disabled = true;
      break;
    case 'logged_in':
      els.oauthLoginStatus.textContent = `Signed in as ${status.username ?? 'unknown'}.`;
      els.oauthLoginBtn.hidden = true;
      els.oauthLogoutBtn.hidden = false;
      void refreshManageableGuilds();
      break;
    case 'error':
      els.oauthLoginStatus.textContent = 'Sign-in failed.';
      els.oauthLoginBtn.hidden = false;
      els.oauthLoginBtn.disabled = false;
      els.oauthLogoutBtn.hidden = true;
      renderGuildList([]);
      if (status.errorMessage) {
        showOAuthError(status.errorMessage);
      }
      break;
  }
}

async function handleOAuthLogin(): Promise<void> {
  await bard.startOAuthLogin();
}

async function handleOAuthLogout(): Promise<void> {
  await bard.oauthLogout();
  const status = await bard.getOAuthLoginStatus();
  renderOAuthLoginStatus(status);
}

function wireEvents(): void {
  els.refreshBtn.addEventListener('click', () => void refreshApps());
  els.tokenSaveBtn.addEventListener('click', () => void handleSaveToken());
  els.startBtn.addEventListener('click', () => void handleStart());
  els.stopBtn.addEventListener('click', () => void handleStop());
  bard.onStatusChanged(renderStreamingStatus);

  els.oauthClientSaveBtn.addEventListener('click', () => void handleSaveOAuthClient());
  els.oauthLoginBtn.addEventListener('click', () => void handleOAuthLogin());
  els.oauthLogoutBtn.addEventListener('click', () => void handleOAuthLogout());
  bard.onOAuthLoginStatusChanged(renderOAuthLoginStatus);
}

async function init(): Promise<void> {
  wireEvents();
  await refreshBotSetupStatus();
  await refreshOAuthClientStatus();
  const status = await bard.getStatus();
  renderStreamingStatus(status);
  await refreshApps();
  const oauthStatus = await bard.getOAuthLoginStatus();
  renderOAuthLoginStatus(oauthStatus);
}

void init();
