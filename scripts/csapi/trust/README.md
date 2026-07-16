# csapi 抗 MITM 信任根（公开材料）

本目录只放 **公开** 的 `cg-mitm/1` 离线 Ed25519 信任根，供懒人安装脚本
`install-csapi-secure.sh` 与 Secure Adapter 作为**唯一信任锚**固定（pin）。

| 文件 | 内容 | 是否可提交 git |
|------|------|----------------|
| `csapi-trust-root-public.json` | 离线根**公钥** + `fingerprint`（无私钥） | ✅ 可提交 |

## 这是什么 / 为什么安全

- Secure Adapter 只固定这里的 **根指纹**（`sha256:...`），不 pin Cloudflare TLS 证书。
- 服务端 `/cg/v1/server-keys` 下发的 HPKE/签名公钥与服务端证书，必须由**这个根签发**才被接受；
  企业 CA / mitmproxy 即使解开 TLS，也无法伪造这条根签发的身份 → Adapter fail-closed。
- **私钥永不进仓库**：离线根私钥是 `cg-trust-root-private.enc`（`master.key` 封装，`0600`），
  只存在于运维 / 离线机器（本仓库 `var/`，已 `.gitignore`）。公钥可放心到处分发、多渠道核对。

当前固定指纹（out-of-band 核对用）：

```
sha256:E9OuniLwYNCVLPPwbG_aMimeFG3Ly1OFnhDplyQwy9g
```

## 生产前置条件（运维必读）

这个公钥要真正生效，运维需在 VPS（csapi）上完成：

1. 把**匹配的**离线根私钥材料（`cg-trust-root-private.enc` + `master.key`）放到运维/离线机器；
2. 生成服务端 HPKE + ES256 keypair，并用该根**签发服务端身份证书**（`allowedOrigins`
   必须含 `https://csapi.joelzt.org`）：

   ```bash
   scripts/csapi/dev-cg-mitm-setup.sh https://csapi.joelzt.org
   ```

   （生产请在离线机器执行根签发部分；`dev-cg-mitm-setup.sh` 是 dev 便捷封装。）
3. 把打印出来的 `CG_*` 增量写入 csapi 的 `.env` 并重启：
   `CG_SECURE_ENABLED=true` + `CG_SERVER_CERT_FILE` / `CG_SERVER_HPKE_KEY_FILE` /
   `CG_SERVER_SIGNING_KEY_FILE` / `CG_TRUST_ROOTS_FILE`（指向本目录同一根的公钥文件）。
   **保持 `CG_REQUIRE_SECURE=false`**，让明文 `/v1/*` 与安全 `/cg/v1/*` 并行灰度。

在此之前，`/cg/v1/server-keys` 不可用，`install-csapi-secure.sh` 会友好报错并提示联系管理员。

## 轮换 / 更换根

若运维用**自己新生成的根**（`scripts/e2ee/trust-root-cli.ts init-cg-root`），需要：

1. 用新根的 `cg-trust-root-public.json` 覆盖本目录的 `csapi-trust-root-public.json`；
2. 同步更新 `install-csapi-secure.sh` 顶部的 `BUILTIN_PINNED_ROOTS`（内嵌指纹，供 `curl|sh` 单文件场景）；
3. 重新分发脚本 / 让用户重跑安装。

指纹不匹配即 fail-closed，绝不回退明文——这是设计目标，不是 bug。
