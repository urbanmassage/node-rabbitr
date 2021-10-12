import Rabbitr from './';

export interface RPCContract<Request extends Object, Response extends Object> {
  Channel: string;
  Request: Request;
  Response: Response;
}

export interface EventContract<Data extends Object> {
  Channel: string;
  Data: Data;
}

export interface RpcListener<TRequest, TResponse> {
  (data: TRequest, message?: Rabbitr.IMessage<TRequest>):
    | TResponse
    | PromiseLike<TResponse>;
}

export class ContractedRabbitr {
  private _rabbitClient: Rabbitr;

  constructor(opts: Rabbitr.IOptions) {
    this._rabbitClient = new Rabbitr(opts);
  }

  addContractedQueueListener<Data>(
    contracts: EventContract<Data>[],
    queue: string,
    opts: Rabbitr.ISubscribeOptions,
    listener: (data: Data, message?: Rabbitr.IMessage<Data>) => PromiseLike<void>,
  ) {
    this._rabbitClient.subscribe(contracts.map(contract => contract.Channel), queue, opts, async (message) => {
      try {
        await listener(message.data, message);
      }
      catch (error) {
        console.log(
          `[rejection] queue listener rejected on queue '${queue}' with error ${(error &&
            error.stack) ||
            error}`
        );
      }
    });
  }

  addContractedRpcListener<Request, Response>(
    contract: RPCContract<Request, Response>,
    opts: Rabbitr.IRpcListenerOptions<Request, Response>,
    listener: RpcListener<Request, Response>
  ) {
    this._rabbitClient.rpcListener(contract.Channel, opts, async (message) => {
      return await listener(message.data, message);
    });
  }

  async contractedSend<Data>(
    contract: EventContract<Data>,
    data: Data,
    context?: any,
  ) {
    await this._rabbitClient.send(contract.Channel, data, { context });
  }

  // TODO cachedRpcExec

  async contractedRpcExec<Request, Response>(
    contract: RPCContract<Request, Response>,
    request: Request,
    opts?: Rabbitr.IRpcExecOptions,
  ): Promise<Response> {
    return await this._rabbitClient.rpcExec(contract.Channel, request, opts);
  }
}
