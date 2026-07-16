# 签名发布骨架（relay-P6）

可信客户端（方案 A 扩展 / 方案 B Secure Adapter）必须通过**不被企业 TLS 覆盖**的渠道到达一次。

## Secure Adapter（方案 B）

推荐流水线：

1. `npm run build -w @cursor-gateway/secure-adapter`
2. 打包安装器：`scripts/csapi/install-csapi-secure.sh` / `.ps1`
3. **minisign**（Ed25519）签名：
   ```bash
   minisign -S -s /path/to/minisign.key -m dist/csapi-secure-adapter.tgz
   ```
4. **Sigstore cosign**（可选第二锚）：
   ```bash
   cosign sign-blob --yes dist/csapi-secure-adapter.tgz > dist/csapi-secure-adapter.tgz.sig
   ```
5. 安装器两段式校验：指纹固定根 + 发布物签名；任一失败 → fail-closed。

## 浏览器扩展（方案 A）

- 开发/内测：Chrome 未打包扩展 ID 已固定（见 `manifest.json` `key`）。
- 生产：Chrome Web Store / 企业 `ExtensionInstallForcelist`。
- **外部 blocker**：本仓库无法代替商店开发者账号完成真实签名上传。需运维持有商店凭证后走人工发布。

## 当前状态

| 项 | 状态 |
|---|---|
| 离线 Ed25519 根 / 安装器 pin | 已有（`scripts/csapi/trust/`） |
| 打包脚本 | `scripts/csapi/sign-extension-release.sh` → zip + SHA256 + Ed25519/minisign |
| 扩展公钥 | `scripts/csapi/trust/extension-ed25519.pub.pem`（私钥 `~/.cursor-gateway/extension-signing/` 0600） |
| 商店签名上传 | **外部凭证 blocker**（Chrome Web Store / Force-install） |
| 扩展 crypto bridge | `cgMitmBridge.ts` + `contentBridge.ts` + background onMessage |
| CS web 桥接探测 | `apps/web/src/cgBridgeDetect.ts`（无扩展时诚实引导安装） |
