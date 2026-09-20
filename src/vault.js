// Fee vaults.
//
// A vault is an ordinary externally-owned account derived from ONE keeper
// secret plus a per-launch public salt. That design has three consequences
// worth stating plainly:
//
//   1. The vault address exists and is computable BEFORE the token launches,
//      so it can be handed to the factory as creatorFeeRecipient at launch
//      time. creatorFeeRecipient is immutable after launch -- getting it wrong
//      is unrecoverable, so it must be right on the first try.
//   2. No private key is ever stored. Signing authority is re-derived on
//      demand from the mnemonic and discarded after use.
//   3. The salt is public. It is an index, not a secret. Knowing every salt
//      reveals every vault ADDRESS and no vault KEY.
//
// The keeper mnemonic is read from the environment only, never a literal and
// never an argument, so it cannot end up in shell history or a process list.

import { ethers } from "ethers";
import { provider } from "./chain.js";

const PURPOSE = "deepshaft/vault/v1";

function phrase() {
  const m = process.env.KEEPER_MNEMONIC;
  if (!m) {
    throw new Error(
      "KEEPER_MNEMONIC is not set. Generate one with `node src/cli.js newmnemonic`, " +
      "put it in .env, and fund the vaults after launching."
    );
  }
  return ethers.Mnemonic.fromPhrase(m.trim());
}

/**
 * Map an arbitrary public salt onto a hardened BIP-44 derivation path.
 * Hashing the salt means a launch can be identified by any human-readable
 * string while the path stays a valid, collision-resistant index triple.
 */
export function pathFor(salt) {
  const h = ethers.keccak256(ethers.toUtf8Bytes(`${PURPOSE}:${salt}`));
  const n = BigInt(h);
  const a = Number((n >> 0n) & 0x7fffffffn);
  const b = Number((n >> 31n) & 0x7fffffffn);
  const c = Number((n >> 62n) & 0x7fffffffn);
  return `m/44'/60'/${a}'/${b}/${c}`;
}

/** A fresh, random public salt for a new launch. */
export const newSalt = () => ethers.hexlify(ethers.randomBytes(16));

/** The vault ADDRESS for a salt. Safe to call anywhere -- returns no key. */
export function vaultAddress(salt) {
  return ethers.HDNodeWallet.fromMnemonic(phrase(), pathFor(salt)).address;
}

/**
 * A connected signer for a vault. Call only at the moment of signing and let
 * it fall out of scope immediately; do not cache it, log it, or return it
 * across a process boundary.
 */
export function vaultSigner(salt) {
  return ethers.HDNodeWallet.fromMnemonic(phrase(), pathFor(salt)).connect(provider);
}

/** Generate a new keeper mnemonic. Printed once, never persisted by us. */
export const generateMnemonic = () => ethers.Wallet.createRandom().mnemonic.phrase;
