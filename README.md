# WorkBuddy 签到面板（公开静态页）

配合私有数据仓 `workbuddy-checkin` 使用。页面本身不含任何账户数据，所有账户信息保存在私有仓。

## 部署

1. 新建公开仓库，例如 `workbuddy-panel`
2. 把本目录（`panel/`）内的文件推到该仓库根目录
3. 仓库 **Settings → Pages** → Source 选择 `Deploy from a branch` → 分支 `main`、目录 `/ (root)`
4. 访问 `https://<你的用户名>.github.io/workbuddy-panel/`

也可以用私有仓部署，但 GitHub Free 账户的私有仓不支持 Pages。

## 访问令牌

在私有仓创建 fine-grained personal access token（**Settings → Developer settings → Personal access tokens → Fine-grained tokens**）：

| 权限 | 级别 | 用途 |
| --- | --- | --- |
| Contents | Read and write | 读写 `accounts.json` |
| Secrets | Read and write | 写入、删除账户 Cookie |
| Actions | Read and write | 触发校验运行 |

令牌只保存在浏览器 localStorage，不会提交到任何仓库。

## 使用流程

1. 打开面板 → 连接设置 → 填写用户名、私有仓名、分支、令牌
2. 添加账户 → 登录 WorkBuddy → 从开发者工具复制完整 Cookie → 粘贴
3. 提交后自动触发一次校验运行，约 1 分钟后点“刷新”查看状态

## 安全边界

- Cookie 单向写入仓库密钥，面板与接口都不回显明文
- 列表仅显示凭证指纹后 6 位
- 删除账户先移除索引，再删除密钥，保留脱敏历史
- 关闭页面不会自动清除令牌，公共电脑请点“断开连接”
