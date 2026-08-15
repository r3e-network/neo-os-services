using System;
using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace MorpheusOracle.Contracts
{
    public partial class MorpheusOracle : SmartContract
    {
        private static ByteString ComputeResultHash(ByteString result)
        {
            return CryptoLib.Sha256(result ?? (ByteString)"");
        }

        private static BigInteger ComputeResultSize(ByteString result)
        {
            return result == null ? 0 : result.Length;
        }

        private static byte[] ToUInt256Bytes(BigInteger value)
        {
            ExecutionEngine.Assert(value >= 0, "invalid uint256");
            byte[] raw = value.ToByteArray();
            int length = raw.Length;
            if (length > 32)
            {
                ExecutionEngine.Assert(length == 33 && raw[32] == 0, "uint256 overflow");
                length = 32;
            }

            byte[] output = new byte[32];
            for (int index = 0; index < length; index++)
            {
                output[31 - index] = raw[index];
            }

            return output;
        }

        private static ByteString ComputeFulfillmentDigest(BigInteger requestId, string appId, string moduleId, string operation, bool success, ByteString result, string error)
        {
            byte[] payload = Helper.Concat(FULFILLMENT_SIGNATURE_DOMAIN, ToUInt256Bytes(requestId));
            payload = Helper.Concat(payload, CryptoLib.Sha256((ByteString)(appId ?? "")));
            payload = Helper.Concat(payload, CryptoLib.Sha256((ByteString)(moduleId ?? "")));
            payload = Helper.Concat(payload, CryptoLib.Sha256((ByteString)(operation ?? "")));
            payload = Helper.Concat(payload, new byte[] { success ? (byte)0x01 : (byte)0x00 });
            payload = Helper.Concat(payload, ComputeResultHash(result));
            payload = Helper.Concat(payload, CryptoLib.Sha256((ByteString)(error ?? "")));
            // Bind the signature to this exact contract deployment and network so a
            // fulfillment signature cannot be replayed against another deployment
            // (e.g. testnet -> mainnet) or a redeploy that shares the same requestId.
            payload = Helper.Concat(payload, (ByteString)Runtime.ExecutingScriptHash);
            payload = Helper.Concat(payload, NetworkMagicLe4());
            return CryptoLib.Sha256((ByteString)payload);
        }

        // 4-byte little-endian encoding of the network magic. Uses BigInteger
        // arithmetic so it lowers cleanly through nccs. The off-chain signer
        // (relayer buildFulfillmentDigestBytes) must reproduce these exact bytes.
        private static byte[] NetworkMagicLe4()
        {
            BigInteger net = (BigInteger)Runtime.GetNetwork();
            return new byte[]
            {
                (byte)(net & 0xFF),
                (byte)((net / 256) & 0xFF),
                (byte)((net / 65536) & 0xFF),
                (byte)((net / 16777216) & 0xFF),
            };
        }
    }
}
