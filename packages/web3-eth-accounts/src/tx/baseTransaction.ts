/*
This file is part of web3.js.

web3.js is free software: you can redistribute it and/or modify
it under the terms of the GNU Lesser General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

web3.js is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Lesser General Public License for more details.

You should have received a copy of the GNU Lesser General Public License
along with web3.js.  If not, see <http://www.gnu.org/licenses/>.
*/

import { Common as CommonType, Numbers } from 'web3-types';
import { bytesToHex } from 'web3-utils';
import { MAX_INTEGER, MAX_UINT64, SECP256K1_ORDER_DIV_2, secp256k1 } from './constants.js';
import { toUint8Array, uint8ArrayToBigInt, unpadUint8Array } from '../common/utils.js';
import { Common } from '../common/common.js';
import { Hardfork, Chain } from '../common/enums.js';
import type {
	AccessListEIP2930TxData,
	AccessListEIP2930ValuesArray,
	FeeMarketEIP1559TxData,
	FeeMarketEIP1559ValuesArray,
	JsonTx,
	TxData,
	TxOptions,
	TxValuesArray,
} from './types.js';
import { Capability, ECDSASignature } from './types.js';
import { Address } from './address.js';
import { checkMaxInitCodeSize } from './utils.js';

interface TransactionCache {
	hash: Uint8Array | undefined;
	dataFee?: {
		value: bigint;
		hardfork: string | Hardfork;
	};
}

/**
 * This base class will likely be subject to further
 * refactoring along the introduction of additional tx types
 * on the Ethereum network.
 *
 * It is therefore not recommended to use directly.
 */
export abstract class BaseTransaction<TransactionObject> {
	private readonly _type: number;

	public readonly nonce: bigint;
	public readonly gasLimit: bigint;
	public readonly to?: Address;
	public readonly value: bigint;
	public readonly data: Uint8Array;

	public readonly v?: bigint;
	public readonly r?: bigint;
	public readonly s?: bigint;

	public readonly common!: Common;

	protected cache: TransactionCache = {
		hash: undefined,
		dataFee: undefined,
	};

	protected readonly txOptions: TxOptions;

	/**
	 * List of tx type defining EIPs,
	 * e.g. 1559 (fee market) and 2930 (access lists)
	 * for FeeMarketEIP1559Transaction objects
	 */
	protected activeCapabilities: number[] = [];

	/**
	 * The default chain the tx falls back to if no Common
	 * is provided and if the chain can't be derived from
	 * a passed in chainId (only EIP-2718 typed txs) or
	 * EIP-155 signature (legacy txs).
	 *
	 * @hidden
	 */
	protected DEFAULT_CHAIN = Chain.Mainnet;

	/**
	 * The default HF if the tx type is active on that HF
	 * or the first greater HF where the tx is active.
	 *
	 * @hidden
	 */
	protected DEFAULT_HARDFORK: string | Hardfork = Hardfork.Merge;

	public constructor(
		txData: TxData | AccessListEIP2930TxData | FeeMarketEIP1559TxData,
		opts: TxOptions,
	) {
		const { nonce, gasLimit, to, value, data, v, r, s, type } = txData;
		this._type = Number(uint8ArrayToBigInt(toUint8Array(type)));

		this.txOptions = opts;

		const toB = toUint8Array(to === '' ? '0x' : to);
		const vB = toUint8Array(v === '' ? '0x' : v);
		const rB = toUint8Array(r === '' ? '0x' : r);
		const sB = toUint8Array(s === '' ? '0x' : s);

		this.nonce = uint8ArrayToBigInt(toUint8Array(nonce === '' ? '0x' : nonce));
		this.gasLimit = uint8ArrayToBigInt(toUint8Array(gasLimit === '' ? '0x' : gasLimit));
		this.to = toB.length > 0 ? new Address(toB) : undefined;
		this.value = uint8ArrayToBigInt(toUint8Array(value === '' ? '0x' : value));
		this.data = toUint8Array(data === '' ? '0x' : data);

		this.v = vB.length > 0 ? uint8ArrayToBigInt(vB) : undefined;
		this.r = rB.length > 0 ? uint8ArrayToBigInt(rB) : undefined;
		this.s = sB.length > 0 ? uint8ArrayToBigInt(sB) : undefined;

		this._validateCannotExceedMaxInteger({ value: this.value, r: this.r, s: this.s });

		// geth limits gasLimit to 2^64-1
		this._validateCannotExceedMaxInteger({ gasLimit: this.gasLimit }, 64);

		// EIP-2681 limits nonce to 2^64-1 (cannot equal 2^64-1)
		this._validateCannotExceedMaxInteger({ nonce: this.nonce }, 64, true);
		// eslint-disable-next-line no-null/no-null
		const createContract = this.to === undefined || this.to === null;
		const allowUnlimitedInitCodeSize = opts.allowUnlimitedInitCodeSize ?? false;
		const common = opts.common ?? this._getCommon();
		if (createContract && common.isActivatedEIP(3860) && !allowUnlimitedInitCodeSize) {
			checkMaxInitCodeSize(common, this.data.length);
		}
	}

	/**
	 * Returns the transaction type.
	 *
	 * Note: legacy txs will return tx type `0`.
	 */
	public get type() {
		return this._type;
	}

	/**
	 * Checks if a tx type defining capability is active
	 * on a tx, for example the EIP-1559 fee market mechanism
	 * or the EIP-2930 access list feature.
	 *
	 * Note that this is different from the tx type itself,
	 * so EIP-2930 access lists can very well be active
	 * on an EIP-1559 tx for example.
	 *
	 * This method can be useful for feature checks if the
	 * tx type is unknown (e.g. when instantiated with
	 * the tx factory).
	 *
	 * See `Capabilites` in the `types` module for a reference
	 * on all supported capabilities.
	 */
	public supports(capability: Capability) {
		return this.activeCapabilities.includes(capability);
	}

	/**
	 * Checks if the transaction has the minimum amount of gas required
	 * (DataFee + TxFee + Creation Fee).
	 */
	public validate(): boolean;
	public validate(stringError: false): boolean;
	public validate(stringError: true): string[];
	public validate(stringError = false): boolean | string[] {
		const errors = [];

		if (this.getBaseFee() > this.gasLimit) {
			errors.push(
				`gasLimit is too low. given ${this.gasLimit}, need at least ${this.getBaseFee()}`,
			);
		}

		if (this.isSigned() && !this.verifySignature()) {
			errors.push('Invalid Signature');
		}

		return stringError ? errors : errors.length === 0;
	}

	protected _validateYParity() {
		const { v } = this;
		if (v !== undefined && v !== BigInt(0) && v !== BigInt(1)) {
			const msg = this._errorMsg('The y-parity of the transaction should either be 0 or 1');
			throw new Error(msg);
		}
	}

	/**
	 * EIP-2: All transaction signatures whose s-value is greater than secp256k1n/2are considered invalid.
	 * Reasoning: https://ethereum.stackexchange.com/a/55728
	 */
	protected _validateHighS() {
		const { s } = this;
		if (this.common.gteHardfork('homestead') && s !== undefined && s > SECP256K1_ORDER_DIV_2) {
			const msg = this._errorMsg(
				'Invalid Signature: s-values greater than secp256k1n/2 are considered invalid',
			);
			throw new Error(msg);
		}
	}

	/**
	 * The minimum amount of gas the tx must have (DataFee + TxFee + Creation Fee)
	 */
	public getBaseFee(): bigint {
		const txFee = this.common.param('gasPrices', 'tx');
		let fee = this.getDataFee();
		if (txFee) fee += txFee;
		if (this.common.gteHardfork('homestead') && this.toCreationAddress()) {
			const txCreationFee = this.common.param('gasPrices', 'txCreation');
			if (txCreationFee) fee += txCreationFee;
		}
		return fee;
	}

	/**
	 * The amount of gas paid for the data in this tx
	 */
	public getDataFee(): bigint {
		const txDataZero = this.common.param('gasPrices', 'txDataZero');
		const txDataNonZero = this.common.param('gasPrices', 'txDataNonZero');

		let cost = BigInt(0);
		// eslint-disable-next-line @typescript-eslint/prefer-for-of
		for (let i = 0; i < this.data.length; i += 1) {
			// eslint-disable-next-line @typescript-eslint/no-unused-expressions, no-unused-expressions
			this.data[i] === 0 ? (cost += txDataZero) : (cost += txDataNonZero);
		}
		// eslint-disable-next-line no-null/no-null
		if ((this.to === undefined || this.to === null) && this.common.isActivatedEIP(3860)) {
			const dataLength = BigInt(Math.ceil(this.data.length / 32));
			const initCodeCost = this.common.param('gasPrices', 'initCodeWordCost') * dataLength;
			cost += initCodeCost;
		}

		return cost;
	}

	/**
	 * The up front amount that an account must have for this transaction to be valid
	 */
	public abstract getUpfrontCost(): bigint;

	/**
	 * If the tx's `to` is to the creation address
	 */
	public toCreationAddress(): boolean {
		return this.to === undefined || this.to.buf.length === 0;
	}

	/**
	 * Returns a Uint8Array Array of the raw Uint8Arrays of this transaction, in order.
	 *
	 * Use {@link BaseTransaction.serialize} to add a transaction to a block
	 * with {@link Block.fromValuesArray}.
	 *
	 * For an unsigned tx this method uses the empty Uint8Array values for the
	 * signature parameters `v`, `r` and `s` for encoding. For an EIP-155 compliant
	 * representation for external signing use {@link BaseTransaction.getMessageToSign}.
	 */
	public abstract raw():
		| TxValuesArray
		| AccessListEIP2930ValuesArray
		| FeeMarketEIP1559ValuesArray;

	/**
	 * Returns the encoding of the transaction.
	 */
	public abstract serialize(): Uint8Array;

	// Returns the unsigned tx (hashed or raw), which is used to sign the transaction.
	//
	// Note: do not use code docs here since VS Studio is then not able to detect the
	// comments from the inherited methods
	public abstract getMessageToSign(hashMessage: false): Uint8Array | Uint8Array[];
	public abstract getMessageToSign(hashMessage?: true): Uint8Array;

	public abstract hash(): Uint8Array;

	public abstract getMessageToVerifySignature(): Uint8Array;

	public isSigned(): boolean {
		const { v, r, s } = this;
		if (v === undefined || r === undefined || s === undefined) {
			return false;
		}
		return true;
	}

	/**
	 * Determines if the signature is valid
	 */
	public verifySignature(): boolean {
		try {
			// Main signature verification is done in `getSenderPublicKey()`
			const publicKey = this.getSenderPublicKey();
			return unpadUint8Array(publicKey).length !== 0;
		} catch (e) {
			return false;
		}
	}

	/**
	 * Returns the sender's address
	 */
	public getSenderAddress(): Address {
		return new Address(Address.publicToAddress(this.getSenderPublicKey()));
	}

	/**
	 * Returns the public key of the sender
	 */
	public abstract getSenderPublicKey(): Uint8Array;

	/**
	 * Signs a transaction.
	 *
	 * Note that the signed tx is returned as a new object,
	 * use as follows:
	 * ```javascript
	 * const signedTx = tx.sign(privateKey)
	 * ```
	 */
	public sign(privateKey: Uint8Array): TransactionObject {
		if (privateKey.length !== 32) {
			const msg = this._errorMsg('Private key must be 32 bytes in length.');
			throw new Error(msg);
		}

		// Hack for the constellation that we have got a legacy tx after spuriousDragon with a non-EIP155 conforming signature
		// and want to recreate a signature (where EIP155 should be applied)
		// Leaving this hack lets the legacy.spec.ts -> sign(), verifySignature() test fail
		// 2021-06-23
		let hackApplied = false;
		if (
			this.type === 0 &&
			this.common.gteHardfork('spuriousDragon') &&
			!this.supports(Capability.EIP155ReplayProtection)
		) {
			this.activeCapabilities.push(Capability.EIP155ReplayProtection);
			hackApplied = true;
		}

		const msgHash = this.getMessageToSign(true);
		const { v, r, s } = this._ecsign(msgHash, privateKey);
		const tx = this._processSignature(v, r, s);

		// Hack part 2
		if (hackApplied) {
			const index = this.activeCapabilities.indexOf(Capability.EIP155ReplayProtection);
			if (index > -1) {
				this.activeCapabilities.splice(index, 1);
			}
		}

		return tx;
	}

	/**
	 * Returns an object with the JSON representation of the transaction
	 */
	public abstract toJSON(): JsonTx;

	// Accept the v,r,s values from the `sign` method, and convert this into a TransactionObject
	protected abstract _processSignature(
		v: bigint,
		r: Uint8Array,
		s: Uint8Array,
	): TransactionObject;

	/**
	 * Does chain ID checks on common and returns a common
	 * to be used on instantiation
	 * @hidden
	 *
	 * @param common - {@link Common} instance from tx options
	 * @param chainId - Chain ID from tx options (typed txs) or signature (legacy tx)
	 */
	protected _getCommon(common?: Common, chainId?: Numbers) {
		// TODO: this function needs to be reviewed and the code to be more clean
		// check issue https://github.com/web3/web3.js/issues/6666
		// Chain ID provided
		if (chainId !== undefined) {
			const chainIdBigInt = uint8ArrayToBigInt(toUint8Array(chainId));
			if (common) {
				if (common.chainId() !== chainIdBigInt) {
					const msg = this._errorMsg(
						'The chain ID does not match the chain ID of Common',
					);
					throw new Error(msg);
				}
				// Common provided, chain ID does match
				// -> Return provided Common
				return common.copy();
			}
			if (Common.isSupportedChainId(chainIdBigInt)) {
				// No Common, chain ID supported by Common
				// -> Instantiate Common with chain ID
				return new Common({ chain: chainIdBigInt, hardfork: this.DEFAULT_HARDFORK });
			}
			// No Common, chain ID not supported by Common
			// -> Instantiate custom Common derived from DEFAULT_CHAIN
			return Common.custom(
				{
					name: 'custom-chain',
					networkId: chainIdBigInt,
					chainId: chainIdBigInt,
				},
				{ baseChain: this.DEFAULT_CHAIN, hardfork: this.DEFAULT_HARDFORK },
			);
		}
		// No chain ID provided
		// -> return Common provided or create new default Common

		if (common?.copy && typeof common?.copy === 'function') {
			return common.copy();
		}
		// TODO: Recheck this next block when working on https://github.com/web3/web3.js/issues/6666
		// This block is to handle when `chainId` was not passed and the `common` object does not have `copy()`
		// If it was meant to be unsupported to process `common` in this case, an exception should be thrown instead of the following block
		if (common) {
			const hardfork =
				typeof common.hardfork === 'function'
					? common.hardfork()
					: // eslint-disable-next-line @typescript-eslint/unbound-method
					  (common.hardfork as unknown as string);

			return Common.custom(
				{
					name: 'custom-chain',
					networkId: common.networkId
						? common.networkId()
						: BigInt((common as unknown as CommonType).customChain?.networkId) ??
						  undefined,
					chainId: common.chainId
						? common.chainId()
						: BigInt((common as unknown as CommonType).customChain?.chainId) ??
						  undefined,
				},
				{
					baseChain: this.DEFAULT_CHAIN,
					hardfork: hardfork || this.DEFAULT_HARDFORK,
				},
			);
		}

		return new Common({ chain: this.DEFAULT_CHAIN, hardfork: this.DEFAULT_HARDFORK });
	}

	/**
	 * Validates that an object with BigInt values cannot exceed the specified bit limit.
	 * @param values Object containing string keys and BigInt values
	 * @param bits Number of bits to check (64 or 256)
	 * @param cannotEqual Pass true if the number also cannot equal one less the maximum value
	 */
	protected _validateCannotExceedMaxInteger(
		values: { [key: string]: bigint | undefined },
		bits = 256,
		cannotEqual = false,
	) {
		for (const [key, value] of Object.entries(values)) {
			switch (bits) {
				case 64:
					if (cannotEqual) {
						if (value !== undefined && value >= MAX_UINT64) {
							const msg = this._errorMsg(
								`${key} cannot equal or exceed MAX_UINT64 (2^64-1), given ${value}`,
							);
							throw new Error(msg);
						}
					} else if (value !== undefined && value > MAX_UINT64) {
						const msg = this._errorMsg(
							`${key} cannot exceed MAX_UINT64 (2^64-1), given ${value}`,
						);
						throw new Error(msg);
					}
					break;
				case 256:
					if (cannotEqual) {
						if (value !== undefined && value >= MAX_INTEGER) {
							const msg = this._errorMsg(
								`${key} cannot equal or exceed MAX_INTEGER (2^256-1), given ${value}`,
							);
							throw new Error(msg);
						}
					} else if (value !== undefined && value > MAX_INTEGER) {
						const msg = this._errorMsg(
							`${key} cannot exceed MAX_INTEGER (2^256-1), given ${value}`,
						);
						throw new Error(msg);
					}
					break;
				default: {
					const msg = this._errorMsg('unimplemented bits value');
					throw new Error(msg);
				}
			}
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	protected static _validateNotArray(values: { [key: string]: any }) {
		const txDataKeys = [
			'nonce',
			'gasPrice',
			'gasLimit',
			'to',
			'value',
			'data',
			'v',
			'r',
			's',
			'type',
			'baseFee',
			'maxFeePerGas',
			'chainId',
		];
		for (const [key, value] of Object.entries(values)) {
			if (txDataKeys.includes(key)) {
				if (Array.isArray(value)) {
					throw new Error(`${key} cannot be an array`);
				}
			}
		}
	}

	/**
	 * Return a compact error string representation of the object
	 */
	public abstract errorStr(): string;

	/**
	 * Internal helper function to create an annotated error message
	 *
	 * @param msg Base error message
	 * @hidden
	 */
	protected abstract _errorMsg(msg: string): string;

	/**
	 * Returns the shared error postfix part for _error() method
	 * tx type implementations.
	 */
	protected _getSharedErrorPostfix() {
		let hash = '';
		try {
			hash = this.isSigned() ? bytesToHex(this.hash()) : 'not available (unsigned)';
		} catch (e) {
			hash = 'error';
		}
		let isSigned = '';
		try {
			isSigned = this.isSigned().toString();
		} catch (e) {
			hash = 'error';
		}
		let hf = '';
		try {
			hf = this.common.hardfork();
		} catch (e) {
			hf = 'error';
		}

		let postfix = `tx type=${this.type} hash=${hash} nonce=${this.nonce} value=${this.value} `;
		postfix += `signed=${isSigned} hf=${hf}`;

		return postfix;
	}
	// eslint-disable-next-line class-methods-use-this
	protected _ecsign(
		msgHash: Uint8Array,
		privateKey: Uint8Array,
		chainId?: bigint,
	): ECDSASignature {
		const signature = secp256k1.sign(msgHash, privateKey);
		const signatureBytes = signature.toCompactRawBytes();

		const r = signatureBytes.subarray(0, 32);
		const s = signatureBytes.subarray(32, 64);

		const v =
			chainId === undefined
				? BigInt(signature.recovery! + 27)
				: BigInt(signature.recovery! + 35) + BigInt(chainId) * BigInt(2);

		return { r, s, v };
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	public static fromSerializedTx(
		// @ts-expect-error unused variable
		serialized: Uint8Array,
		// @ts-expect-error unused variable
		opts: TxOptions = {},
		// eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/no-explicit-any
	): any {}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	public static fromTxData(
		// @ts-expect-error unused variable
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		txData: any,
		// @ts-expect-error unused variable
		opts: TxOptions = {},
		// eslint-disable-next-line @typescript-eslint/no-empty-function, @typescript-eslint/no-explicit-any
	): any {}
}
