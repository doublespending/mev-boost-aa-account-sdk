import { BigNumberish, BytesLike, ethers } from "ethers";
import {
  Constants,
  UserOperationBuilder,
  BundlerJsonRpcProvider,
  Presets,
  IPresetBuilderOpts,
  UserOperationMiddlewareFn,
} from "userop";
import {
  MEVBoostAccountFactory,
  MEVBoostAccount__factory,
  IMEVBoostAccount,
  MEVBoostAccount as MEVBoostAccountImpl,
  MEVBoostAccountFactory__factory,
  MEVBoostPaymaster,
  MEVBoostPaymaster__factory,
} from "@mev-boost-aa/contracts";
import {
  EntryPoint,
  EntryPoint__factory,
} from "@account-abstraction/contracts";
import { MEVBoostAA } from "./constants";
import { estimateUserOperationGas, EOASignature } from "./middleware";

export interface IMEVBoostAccountBuilderOpts extends IPresetBuilderOpts {
  mevBoostPaymaster?: string;
}

export class MEVBoostAccount extends UserOperationBuilder {
  private signer: ethers.Signer;
  private provider: ethers.providers.JsonRpcProvider;
  private entryPoint: EntryPoint;
  private factory: MEVBoostAccountFactory;
  private mevBoostPaymaster: MEVBoostPaymaster;
  private initCode: string;
  private proxy: MEVBoostAccountImpl;

  private constructor(
    signer: ethers.Signer,
    rpcUrl: string,
    opts?: IMEVBoostAccountBuilderOpts
  ) {
    super();
    this.signer = signer;
    this.provider = new BundlerJsonRpcProvider(rpcUrl).setBundlerRpc(
      opts?.overrideBundlerRpc
    );
    this.entryPoint = EntryPoint__factory.connect(
      opts?.entryPoint || Constants.ERC4337.EntryPoint,
      this.provider
    );
    this.factory = MEVBoostAccountFactory__factory.connect(
      opts?.factory || MEVBoostAA.Factory,
      this.provider
    );
    this.initCode = "0x";
    this.proxy = MEVBoostAccount__factory.connect(
      ethers.constants.AddressZero,
      this.provider
    );

    this.mevBoostPaymaster = MEVBoostPaymaster__factory.connect(
      opts?.mevBoostPaymaster || MEVBoostAA.MEVBoostPaymaster,
      this.provider
    );
  }

  private resolveAccount: UserOperationMiddlewareFn = async (ctx) => {
    ctx.op.nonce = await this.entryPoint.getNonce(ctx.op.sender, 0);
    ctx.op.initCode = ctx.op.nonce.eq(0) ? this.initCode : "0x";
  };

  public static async init(
    signer: ethers.Signer,
    rpcUrl: string,
    opts?: IMEVBoostAccountBuilderOpts
  ): Promise<MEVBoostAccount> {
    const instance = new MEVBoostAccount(signer, rpcUrl, opts);

    try {
      instance.initCode = await ethers.utils.hexConcat([
        instance.factory.address,
        instance.factory.interface.encodeFunctionData("createAccount", [
          await instance.signer.getAddress(),
          instance.mevBoostPaymaster.address,
          ethers.BigNumber.from(0),
        ]),
      ]);

      await instance.entryPoint.callStatic.getSenderAddress(instance.initCode);

      throw new Error("getSenderAddress: unexpected result");
    } catch (error: any) {
      const addr = error?.errorArgs?.sender;
      if (!addr) throw error;

      instance.proxy = MEVBoostAccount__factory.connect(
        addr,
        instance.provider
      );
    }

    const base = instance
      .useDefaults({
        sender: instance.proxy.address,
        signature: await instance.signer.signMessage(
          ethers.utils.arrayify(ethers.utils.keccak256("0xdead"))
        ),
      })
      .useMiddleware(instance.resolveAccount)
      .useMiddleware(Presets.Middleware.getGasPrice(instance.provider));

    const withPM = opts?.paymasterMiddleware
      ? base.useMiddleware(opts.paymasterMiddleware)
      : base.useMiddleware(estimateUserOperationGas(instance.provider));

    return withPM.useMiddleware(
      EOASignature(instance.provider, instance.signer)
    );
  }

  execute(to: string, value: BigNumberish, data: BytesLike) {
    return this.setCallData(
      this.proxy.interface.encodeFunctionData("execute", [to, value, data])
    );
  }

  executeBatch(
    to: Array<string>,
    value: Array<BigNumberish>,
    data: Array<BytesLike>
  ) {
    return this.setCallData(
      this.proxy.interface.encodeFunctionData("executeBatch", [to, value, data])
    );
  }

  boostExecute(
    config: IMEVBoostAccount.MEVConfigStruct,
    to: string,
    value: BigNumberish,
    data: BytesLike
  ) {
    return this.setCallData(
      this.proxy.interface.encodeFunctionData("boostExecute", [
        config,
        to,
        value,
        data,
      ])
    );
  }

  boostExecuteBatch(
    config: IMEVBoostAccount.MEVConfigStruct,
    to: Array<string>,
    value: Array<BigNumberish>,
    data: Array<BytesLike>
  ) {
    return this.setCallData(
      this.proxy.interface.encodeFunctionData("boostExecuteBatch", [
        config,
        to,
        value,
        data,
      ])
    );
  }

  async boostWait(
    userOpHash: string,
    deadlineMs?: number,
    waitIntervalMs: number = 5000
  ) {
    const end = deadlineMs || Date.now() + 30000;
    const block = await this.provider.getBlock("latest");
    while (Date.now() < end) {
      const events = await this.mevBoostPaymaster.queryFilter(
        this.mevBoostPaymaster.filters.SettleUserOp(null, userOpHash),
        Math.max(0, block.number - 100)
      );
      if (events.length > 0) {
        return events[0];
      }
      await new Promise((resolve) => setTimeout(resolve, waitIntervalMs));
    }

    return null;
  }
}
