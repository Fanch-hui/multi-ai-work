import { join } from 'node:path';
import { z } from 'zod';
import type { Bot, Connection } from '../domain/types.js';
import { AuthenticationRequiredError, type ProviderAdapter } from '../domain/provider.js';
import { detectNativeSetup, type NativeSetup } from '../providers/native/setup.js';
import { supplementChatGptCatalog } from '../providers/managed/catalog.js';
import { OAuthManager } from '../security/oauth.js';
import type { Vault } from '../security/vault.js';
import type { State } from './state.js';
import type { EntityService } from './entities.js';
import type { Scheduler } from './scheduler.js';
import { ConnectionLogin } from './connection-login.js';
import { publicError, required } from './errors.js';

export class CoreConnections {
  private oauth: OAuthManager;
  private logins: ConnectionLogin;

  constructor(
    private state: State,
    private vault: Vault,
    private scheduler: Scheduler,
    private adapters: ProviderAdapter[],
    private entities: EntityService,
  ) {
    const s = state.storage;
    this.oauth = new OAuthManager(vault, {
      get: (key) => s.metadata(key),
      set: (key, value) => s.setMetadata(key, value),
    });
    this.logins = new ConnectionLogin(state, this.oauth);
  }

  closeLogins() {
    this.logins.close();
  }
  closeOAuth() {
    this.oauth.close();
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const s = this.state.storage;
    const objectId = () => z.string().parse(params.id);
    switch (method) {
      case 'connections.save': {
        const connection = await this.entities.saveConnection(params.input);
        this.logins.cancel(connection.id);
        return connection;
      }
      case 'connections.probe':
        return this.probe(objectId());
      case 'connections.login':
        return this.login(objectId());
      case 'connections.logout':
        return this.logout(objectId());
      case 'connections.delete': {
        const connectionId = objectId();
        this.logins.cancel(connectionId);
        await this.scheduler.cancelConnection(connectionId);
        const connection = s.get<Connection>('connections', connectionId);
        if (connection?.secretRef) await this.vault.delete(connection.secretRef);
        this.oauth.cancel(connectionId);
        s.delete('connections', connectionId);
        break;
      }
      default:
        throw new Error('不支持的应用操作');
    }
    this.state.changed();
    return { ok: true };
  }

  async chiefCatalog() {
    const s = this.state.storage;
    const chief = required(s.get<Bot>('bots', this.state.settings().mainBotId!), '主智能体不存在');
    const connection = required(
      s.get<Connection>('connections', chief.connectionId),
      '请先配置主管连接',
    );
    if (connection.provider !== 'chatgpt' || connection.status !== 'ready') return connection;
    const models = await supplementChatGptCatalog(connection.models);
    const current = required(s.get<Connection>('connections', connection.id), '连接不存在');
    if (current.revision !== connection.revision) return current;
    const updated = { ...current, models };
    s.put('connections', updated);
    this.state.changed();
    return updated;
  }

  async refreshBotContextCatalog(input: unknown, current?: Bot) {
    const fields = z
      .object({
        connectionId: z.string().optional(),
        model: z.string().optional(),
        contextWindow: z.number().optional(),
      })
      .parse(input);
    const window = fields.contextWindow ?? current?.contextWindow;
    const connection = this.state.storage.get<Connection>(
      'connections',
      fields.connectionId ?? current?.connectionId ?? '',
    );
    if (!window || connection?.provider !== 'chatgpt' || connection.status !== 'ready') return;
    const model = connection.models.find((item) => item.id === (fields.model ?? current?.model));
    if (
      !model ||
      model.maxContextWindow !== undefined ||
      !model.contextWindow ||
      window <= model.contextWindow
    )
      return;
    await this.probe(connection.id);
  }

  private async probe(connectionId: string) {
    const s = this.state.storage;
    let connection = required(s.get<Connection>('connections', connectionId), '连接不存在');
    const adapter = required(
      this.adapters.find((item) => item.kind === connection.provider),
      '连接类型不支持',
    );
    try {
      if (connection.provider === 'antigravity' || connection.provider === 'qoder') {
        const setup = await this.nativeSetup(connection);
        if (!setup.executable) throw new Error('未找到原生运行时，请点击登录查看安装指引。');
        connection = {
          ...connection,
          executable: setup.executable,
          executableMode:
            connection.executableMode ?? (connection.executable ? 'explicit' : 'auto'),
          revision:
            connection.executable && connection.executable !== setup.executable
              ? connection.revision + 1
              : connection.revision,
        };
      }
      const result = await adapter.probe({
        connection,
        signal: AbortSignal.timeout(45000),
        getSecret: (ref) => this.vault.get(ref),
        saveSecret: (ref, value) => this.vault.set(ref, value),
      });
      const updated = { ...connection, ...result, status: 'ready' as const, error: undefined };
      s.put('connections', updated);
      this.state.changed();
      return updated;
    } catch (error) {
      s.put('connections', {
        ...connection,
        status: error instanceof AuthenticationRequiredError ? 'needs_auth' : 'error',
        error: publicError(error),
      });
      this.state.changed();
      throw error;
    }
  }
  private async login(connectionId: string) {
    let connection = required(
      this.state.storage.get<Connection>('connections', connectionId),
      '连接不存在',
    );
    if (connection.provider === 'custom') throw new Error('自定义 API 请在连接配置中填写凭据。');
    await this.scheduler.cancelConnection(connectionId);
    if (connection.provider === 'chatgpt') return this.logins.start(connectionId);
    connection = {
      ...connection,
      revision: connection.revision + 1,
      status: 'needs_auth',
      error: undefined,
    };
    this.state.storage.put('connections', connection);
    this.state.changed();
    let setup: NativeSetup;
    try {
      setup = await this.nativeSetup(connection);
    } catch (error) {
      this.state.storage.put('connections', {
        ...connection,
        status: 'error',
        error: publicError(error),
      });
      this.state.changed();
      throw error;
    }
    connection = {
      ...connection,
      executable: setup.executable,
      executableMode: connection.executableMode ?? (connection.executable ? 'explicit' : 'auto'),
      status: setup.executable ? 'needs_auth' : 'error',
      error: setup.executable ? undefined : '未找到原生运行时，请查看安装指引或指定运行时路径。',
    };
    this.state.storage.put('connections', connection);
    this.state.changed();
    let instructions: string;
    if (setup.executable) {
      instructions =
        connection.provider === 'antigravity'
          ? '已找到本机 agy。已有登录可直接检测连接；尚未登录时，在终端运行下面的命令并完成官方授权，再回到这里检测。原生工具权限沿用 agy 设置，App 管理团队操作权限。'
          : '已找到本机 Qoder CN。已有登录可直接检测连接；尚未登录时，在终端运行下面的命令完成官方登录，再回到这里检测。';
    } else {
      instructions =
        connection.provider === 'antigravity'
          ? '未找到 agy。请在终端运行以下官方安装命令，安装并登录后检测连接。'
          : '未找到运行时。请用已安装的 Node.js 执行以下安装命令，完成后再次点击登录。';
    }
    return {
      instructions,
      command: setup.loginCommand ?? setup.installCommand,
    };
  }
  private async logout(connectionId: string) {
    this.logins.cancel(connectionId);
    await this.scheduler.cancelConnection(connectionId);
    const connection = required(
      this.state.storage.get<Connection>('connections', connectionId),
      '连接不存在',
    );
    const result =
      connection.provider === 'chatgpt'
        ? await this.oauth.signOut(connectionId)
        : { remoteRevocationConfirmed: false };
    if (connection.secretRef) await this.vault.delete(connection.secretRef);
    this.state.storage.put('connections', {
      ...connection,
      secretRef: undefined,
      status: 'needs_auth',
      revision: connection.revision + 1,
    });
    this.state.changed();
    return result;
  }
  private nativeSetup(connection: Connection) {
    return detectNativeSetup({
      provider: connection.provider as 'antigravity' | 'qoder',
      executable: connection.executableMode === 'auto' ? undefined : connection.executable,
      profilePath: connection.profilePath!,
      appRuntimeDirectory: join(this.state.dataDirectory, 'runtimes'),
    });
  }
}
