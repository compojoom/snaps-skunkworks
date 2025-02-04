import assert from 'assert';
import { ControllerMessenger } from '@metamask/controllers';
import { ErrorJSON, SnapId } from '@metamask/snap-types';
import { JsonRpcEngine } from 'json-rpc-engine';
import { createEngineStream } from 'json-rpc-middleware-stream';
import pump from 'pump';
import { ErrorMessageEvent } from '../ExecutionService';
import { setupMultiplex } from '../AbstractExecutionService';
import { NodeProcessExecutionService } from './NodeProcessExecutionService';

describe('NodeProcessExecutionService', () => {
  it('can boot', async () => {
    const controllerMessenger = new ControllerMessenger<
      never,
      ErrorMessageEvent
    >();
    const service = new NodeProcessExecutionService({
      messenger: controllerMessenger.getRestricted<
        'ExecutionService',
        never,
        ErrorMessageEvent['type']
      >({
        name: 'ExecutionService',
      }),
      setupSnapProvider: () => {
        // do nothing
      },
    });
    expect(service).toBeDefined();
    await service.terminateAllSnaps();
  });

  it('can create a snap worker and start the snap', async () => {
    const controllerMessenger = new ControllerMessenger<
      never,
      ErrorMessageEvent
    >();
    const service = new NodeProcessExecutionService({
      messenger: controllerMessenger.getRestricted<
        'ExecutionService',
        never,
        ErrorMessageEvent['type']
      >({
        name: 'ExecutionService',
      }),
      setupSnapProvider: () => {
        // do nothing
      },
    });
    const response = await service.executeSnap({
      snapId: 'TestSnap',
      sourceCode: `
        console.log('foo');
      `,
      endowments: ['console'],
    });
    expect(response).toStrictEqual('OK');
    await service.terminateAllSnaps();
  });

  it('can handle a crashed snap', async () => {
    expect.assertions(1);
    const controllerMessenger = new ControllerMessenger<
      never,
      ErrorMessageEvent
    >();
    const service = new NodeProcessExecutionService({
      messenger: controllerMessenger.getRestricted<
        'ExecutionService',
        never,
        ErrorMessageEvent['type']
      >({
        name: 'ExecutionService',
      }),
      setupSnapProvider: () => {
        // do nothing
      },
    });
    const action = async () => {
      await service.executeSnap({
        snapId: 'TestSnap',
        sourceCode: `
          throw new Error("potato");
        `,
        endowments: [],
      });
    };

    await expect(action()).rejects.toThrow(
      /Error while running snap 'TestSnap'/u,
    );
    await service.terminateAllSnaps();
  });

  it('can handle errors in request handler', async () => {
    expect.assertions(1);
    const controllerMessenger = new ControllerMessenger<
      never,
      ErrorMessageEvent
    >();
    const service = new NodeProcessExecutionService({
      messenger: controllerMessenger.getRestricted<
        'ExecutionService',
        never,
        ErrorMessageEvent['type']
      >({
        name: 'ExecutionService',
      }),
      setupSnapProvider: () => {
        // do nothing
      },
    });
    const snapId = 'TestSnap';
    await service.executeSnap({
      snapId,
      sourceCode: `
      module.exports.onRpcRequest = async () => { throw new Error("foobar"); };
      `,
      endowments: [],
    });

    const hook = await service.getRpcRequestHandler(snapId);

    assert(hook !== undefined);

    await expect(
      hook('fooOrigin', {
        jsonrpc: '2.0',
        method: 'foo',
        params: {},
        id: 1,
      }),
    ).rejects.toThrow('foobar');
    await service.terminateAllSnaps();
  });

  it('can handle errors out of band', async () => {
    expect.assertions(2);
    const controllerMessenger = new ControllerMessenger<
      never,
      ErrorMessageEvent
    >();
    const service = new NodeProcessExecutionService({
      messenger: controllerMessenger.getRestricted<
        'ExecutionService',
        never,
        ErrorMessageEvent['type']
      >({
        name: 'ExecutionService',
      }),
      setupSnapProvider: () => {
        // do nothing
      },
    });
    const snapId = 'TestSnap';
    await service.executeSnap({
      snapId,
      sourceCode: `
      module.exports.onRpcRequest = async () => 
      { 
        new Promise((resolve, _reject) => {
          let num = 0;
          while (num < 100) {
            // eslint-disable-next-line no-plusplus
            num++;
          }
          throw new Error('random error inside');
          resolve(undefined);
        });
        return 'foo';
       };
      `,
      endowments: [],
    });

    const hook = await service.getRpcRequestHandler(snapId);

    assert(hook !== undefined);

    const unhandledErrorPromise = new Promise((resolve) => {
      controllerMessenger.subscribe(
        'ExecutionService:unhandledError',
        (_snapId: SnapId, error: ErrorJSON) => {
          resolve(error);
        },
      );
    });

    expect(
      await hook('fooOrigin', {
        jsonrpc: '2.0',
        method: '',
        params: {},
        id: 1,
      }),
    ).toBe('foo');

    // eslint-disable-next-line jest/prefer-strict-equal
    expect(await unhandledErrorPromise).toEqual({
      code: -32603,
      data: { snapName: 'TestSnap' },
      message: 'Unhandled promise rejection in snap.',
    });

    await service.terminateAllSnaps();
  });

  it('can detect outbound requests', async () => {
    expect.assertions(4);
    const blockNumber = '0xa70e75';
    const controllerMessenger = new ControllerMessenger<
      never,
      ErrorMessageEvent
    >();
    const messenger = controllerMessenger.getRestricted<
      'ExecutionService',
      never,
      ErrorMessageEvent['type']
    >({
      name: 'ExecutionService',
    });
    const publishSpy = jest.spyOn(messenger, 'publish');
    const service = new NodeProcessExecutionService({
      messenger,
      setupSnapProvider: (_snapId, rpcStream) => {
        const mux = setupMultiplex(rpcStream, 'foo');
        const stream = mux.createStream('metamask-provider');
        const engine = new JsonRpcEngine();
        engine.push((req, res, next, end) => {
          if (req.method === 'metamask_getProviderState') {
            res.result = { isUnlocked: false, accounts: [] };
            return end();
          } else if (req.method === 'eth_blockNumber') {
            res.result = blockNumber;
            return end();
          }
          return next();
        });
        const providerStream = createEngineStream({ engine });
        pump(stream, providerStream, stream);
      },
    });
    const snapId = 'TestSnap';
    const executeResult = await service.executeSnap({
      snapId,
      sourceCode: `
      module.exports.onRpcRequest = () => wallet.request({ method: 'eth_blockNumber', params: [] });
      `,
      endowments: [],
    });

    expect(executeResult).toBe('OK');

    const handler = await service.getRpcRequestHandler(snapId);

    assert(handler !== undefined);

    const result = await handler('foo', {
      jsonrpc: '2.0',
      id: 1,
      method: 'foobar',
      params: [],
    });

    expect(result).toBe(blockNumber);

    expect(publishSpy).toHaveBeenCalledWith(
      'ExecutionService:outboundRequest',
      'TestSnap',
    );

    expect(publishSpy).toHaveBeenCalledWith(
      'ExecutionService:outboundResponse',
      'TestSnap',
    );

    await service.terminateAllSnaps();
  });
});
