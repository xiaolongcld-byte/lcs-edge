# LCS Edge Node 部署包（多地区自建节点）

同一份 `server.js` 可以部署到下面任意一个免费平台，每个平台给一个地区。全部用 VLESS over WebSocket，
和已有的 Cloudflare Pages 节点协议一致，客户端链接格式也一致，只是 host 不同。

## 一键部署（按地区选平台）

| 地区 | 平台 | 免费额度 | 部署方式 |
|---|---|---|---|
| 美国 Oregon | Render | 750h/月 web service | GitHub 仓库 + `render.yaml` |
| 德国 Frankfurt | Render | 同上 | 改 `region: frankfurt` |
| 新加坡 | Render | 同上 | 改 `region: singapore` |
| 美国 Washington | Koyeb | 1 web service 免费 | `koyeb app init` 或控制台 |
| 德国 Frankfurt | Koyeb | 同上 | `region: fra` |
| 美国/欧洲 | Hugging Face Spaces | Docker Space 免费 | `Dockerfile` 直接上传 |

## Render（推荐，4 个地区可选）

1. 把本目录推到任意 GitHub 仓库（public/private 都行）。
2. Render 控制台 → New → Blueprint → 选仓库，自动读 `render.yaml`。
3. 改 `render.yaml` 里的 `region` 可换地区：`oregon` / `frankfurt` / `singapore` / `ohio` / `virginia`。
4. 部署完成后地址形如 `https://lcs-edge-XXXX.onrender.com`。

或者命令行（需 `render` CLI + API key）：

```bash
render deploy --branch main
```

## Koyeb

```bash
koyeb app init lcs-edge-de --docker . --regions fra --ports 8080:http --routes /:8080 --env LCS_UUID=b8842589-bf9c-4a9b-a0c0-811e6ebaa629 --env LCS_PATH=/ws-f798d2b213
```

地区代号：`was`（美国华盛顿）、`fra`（德国法兰克福）、`sin`（新加坡）。

## Hugging Face Spaces（Docker）

1. 新建 Docker Space，选地区（US / EU）。
2. 上传本目录全部文件（含 `Dockerfile`）。
3. Space 地址形如 `https://<user>-<space>.hf.space`，端口 7860 会自动映射。

## 部署后接线（一条命令）

```powershell
python _deploy_edge.py --host xxx.onrender.com --label US_OR
python _deploy_edge.py --host yyy.onrender.com --label DE_FRA
```

脚本会：探测 TLS 可达性 → 起 sing-box 走该节点取 `generate_204` → 通过节点查 IP 与 geoip
→ 写进 `C:\Users\26019\LCS-Velocity\nodes_pool.json`（verified=true）并给出 vless 链接。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LCS_UUID` | `b8842589-bf9c-4a9b-a0c0-811e6ebaa629` | VLESS 用户 ID，换掉等于换密码 |
| `LCS_PATH` | `/ws-f798d2b213` | WebSocket 路径，非该路径一律 200 迷惑页 |
| `PORT` | `8080` | 平台注入，一般不用改 |

## 已验证的限制（不是 bug）

- 平台侧禁止拨自家内网/元数据地址，`169.254.169.254` 这类会被拒。
- 部分目标站（X / OpenAI / Wikipedia）会封机房 IP，任何数据中心节点都一样。
- 免费层有休眠策略：Render 免费 web service 15 分钟无请求会睡，首个请求冷启动 ~30s。
