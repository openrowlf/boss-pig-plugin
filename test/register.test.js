import { describe, it, expect, vi } from 'vitest';
import register from '../src/index.js';

describe('plugin registration', () => {
  it('registers gateway method and service by default (command disabled)', () => {
    const registerGatewayMethod = vi.fn();
    const registerCommand = vi.fn();
    const registerService = vi.fn();

    const api = {
      entry: { config: { apiKey: 'bp_test', mcpUrl: 'https://bosspig.moi/mcp' } },
      config: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      runtime: {
        state: {
          resolveStateDir: () => '/tmp',
        },
      },
      registerGatewayMethod,
      registerCommand,
      registerService,
    };

    register(api);

    expect(registerGatewayMethod).toHaveBeenCalledTimes(1);
    expect(registerGatewayMethod.mock.calls[0][0]).toBe('bosspig.status');

    expect(registerCommand).toHaveBeenCalledTimes(0);

    expect(registerService).toHaveBeenCalledTimes(1);
    const svc = registerService.mock.calls[0][0];
    expect(svc.id).toBe('boss-pig-plugin.service');
    expect(typeof svc.start).toBe('function');
    expect(typeof svc.stop).toBe('function');
  });

  it('registers manual command when enabled', () => {
    const registerCommand = vi.fn();
    const api = {
      entry: { config: { apiKey: 'bp_test', mcpUrl: 'https://bosspig.moi/mcp', manualCommandEnabled: true } },
      config: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      runtime: { state: { resolveStateDir: () => '/tmp' } },
      registerGatewayMethod: vi.fn(),
      registerCommand,
      registerService: vi.fn(),
    };

    register(api);
    expect(registerCommand).toHaveBeenCalledTimes(1);
    expect(registerCommand.mock.calls[0][0].name).toBe('bosspig-check');
  });

  it('service start is safe when disabled or missing apiKey', async () => {
    const registerService = vi.fn();

    const apiDisabled = {
      entry: { config: { enabled: false } },
      config: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      runtime: { state: { resolveStateDir: () => '/tmp' } },
      registerGatewayMethod: vi.fn(),
      registerCommand: vi.fn(),
      registerService,
    };

    register(apiDisabled);
    const disabledSvc = registerService.mock.calls[0][0];
    expect(() => disabledSvc.start()).not.toThrow();

    const registerService2 = vi.fn();
    const apiNoKey = {
      entry: { config: { enabled: true, mcpUrl: 'https://bosspig.moi/mcp' } },
      config: {},
      logger: { info: vi.fn(), warn: vi.fn() },
      runtime: { state: { resolveStateDir: () => '/tmp' } },
      registerGatewayMethod: vi.fn(),
      registerCommand: vi.fn(),
      registerService: registerService2,
    };

    register(apiNoKey);
    const noKeySvc = registerService2.mock.calls[0][0];
    expect(() => noKeySvc.start()).not.toThrow();
  });
});
