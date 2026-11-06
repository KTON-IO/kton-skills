// What the bundle takes of @ton/crypto: the three functions @ton/core calls
// (cell hashes, and signing it never does here). The rest of the package,
// recovery phrases and their word list included, stays out of the script,
// which never asks for or reads one.
const { sha256_sync } = require("../node_modules/@ton/crypto/dist/primitives/sha256.js");
const { sign, signVerify } = require("../node_modules/@ton/crypto/dist/primitives/nacl.js");

module.exports = { sha256_sync, sign, signVerify };
