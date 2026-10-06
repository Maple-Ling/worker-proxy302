# worker-proxy302
这是一个用worker搭建的lucky穿透后302重定向的项目，用于随机穿透后使用固定域名访问转跳到最新的ip:port
# Lucky Webhook + Cloudflare Worker 动态跳转 · 部署与配置文档

> 用途：Lucky 的 STUN 穿透端口是动态的，通过 Worker + KV 把「子域名 → 当前 IP:端口」的映射记下来，
> 访问 `http://<前缀>.dns.域名/` 时自动 302 跳转到家里对应的服务。

---

## 一、环境变量（Cloudflare Worker → Settings → Variables and Secrets）

| 变量名           | 必填 | 当前值                   | 说明                                                         |
| ---------------- | ---- | ------------------------ | ------------------------------------------------------------ |
| `DDNS_DOMAIN`    | ✅    | `dns.域名`               | **不带子域前缀**。用于：① 管理页生成 Webhook 地址；② 判断请求是走跳转还是显示管理页；③ 列表页显示访问地址。**删了 Worker 会直接报「缺少 DDNS_DOMAIN 环境变量」** |
| `AUTH_TOKEN`     | ✅    | 自己生成的长随机串       | Bearer Token。Lucky 上报和管理页 API 调用都用它鉴权          |
| `ADMIN_PASSWORD` | ✅    | `******`（建议改强密码） | 管理页登录密码。只是前端门禁，**真正保护数据的是 AUTH_TOKEN** |

> 改完变量后需要**重新部署**一次才生效。

## 二、KV 绑定

| 项目                       | 值                                                    |
| -------------------------- | ----------------------------------------------------- |
| 绑定变量名（Binding name） | **`proxy`**（代码里是 `env.proxy`，名字必须完全一致） |
| 命名空间                   | 自建，任意名字                                        |

## 三、KV 键结构

| 键            | 值示例            | 说明                                                         |
| ------------- | ----------------- | ------------------------------------------------------------ |
| `global:host` | 111.111.111.111   | **全局公网 IP，所有服务共用一条**。由 Lucky 上报时写入（每次都覆盖） |
| `<前缀>:port` | `22843`           | 每个服务的穿透端口。更新时间存在该键的 **metadata**（`updated_at`），不额外占键 |
| `<前缀>:host` | `1.2.3.4`（可选） | 手动添加时才存在。用于给**单个前缀**指定专用 IP，**优先级高于 `global:host`**（比如以后某台 VPS 也走这套） |

示例（3 个服务）：

```
global:host  = 111.111.111.111
piweb:port   = 22843
fnos:port    = 24711
pc:port      = 3389
```

## 四、Cloudflare 配置

| 项目                 | 配置                                                       |
| -------------------- | ---------------------------------------------------------- |
| **Worker 路由**      | `*.dns.域名/*`，Zone = `域名`                              |
| **DNS 泛解析**       | `*.dns.域名` → **橙云（Proxied）**，必须存在，这是访问入口 |
| `dns.域名` 的 A 记录 | **可以删除**（跳转不再依赖它，改用 KV 里的 IP）            |

> ⚠️ 注意区分：**DNS 泛解析** 和 **Worker 路由** 是两套东西，都要配。
> 二级子域通配 `*.dns.域名` 不会影响 `maple521.cc.cd` 下的其他一级子域，给别的 VPS 用域名互不干扰。

## 五、Lucky Webhook 配置（每个服务一条）

| 字段   | 值                                                 |
| ------ | -------------------------------------------------- |
| URL    | `http://<前缀>.dns.域名/__update_port`             |
| 方法   | `POST`                                             |
| 请求头 | `Authorization: Bearer <AUTH_TOKEN>`               |
| 请求体 | `{"sub":"<前缀>","host":"#{ip}","port":"#{port}"}` |

Lucky 支持的变量（实测）：

```
#{time}      触发 Webhook 的时间
#{ipAddr}    当前 STUN 穿透获得的公网 IP 地址（含端口），如 192.168.1.1:16666
#{ip}        公网 IP 的 IP 部分，如 192.168.1.1      ← 我们用这个
#{port}      公网 IP 地址中的端口部分，如 16666       ← 我们用这个
#{ruleName}  规则名称
```

> 多个服务 = 多条 Webhook，**只有 `sub` 不同**，其余完全一样。
> Lucky 保存配置时会测试一次，端口变化时会再上报，每次都会刷新 KV。

## 六、请求处理流程

```
浏览器  http://piweb.dns.域名/
   │  （DNS 泛解析 → Cloudflare，路由匹配 → Worker）
   ▼
Worker  读 KV：global:host = 111.111.111.111
              piweb:port  = 22843
   ▼
302  →  http://111.111.111.111:22843/        （路径和查询参数原样保留）


Lucky   POST /__update_port  {"sub":"piweb","host":"111.111.111.111","port":"22843"}
   ▼
Worker  写 KV：global:host、piweb:port（带 metadata.updated_at）
```

**跳转目标优先级**：`<前缀>:host`（手动专用）→ `global:host` → DoH 解析 `DDNS_DOMAIN` → 回退用域名。

## 七、API 端点一览

| 端点                      | 方法 | 鉴权   | 说明                                                       |
| ------------------------- | ---- | ------ | ---------------------------------------------------------- |
| `/` `/admin`              | GET  | 无     | 管理页（HTML，含登录门禁）                                 |
| `/__admin_check_password` | POST | 无     | 校验管理密码                                               |
| `/__update_port`          | POST | Bearer | Lucky 上报，写 KV。支持单条对象或数组                      |
| `/__get_port?sub=x`       | GET  | Bearer | 查询单个前缀                                               |
| `/__list_ports`           | GET  | Bearer | 列出全部前缀（遍历 KV）                                    |
| `/__delete_port`          | POST | Bearer | 删除某前缀（body: `{"sub":"x"}`）                          |
| 其他任意路径              | *    | 无     | 按 Host 取前缀 → 302 跳转到 `http://<host>:<port><原路径>` |

## 八、部署步骤（从零开始）

1. **创建 KV 命名空间**，在 Worker 里绑定，Binding name 填 `proxy`
2. **设置环境变量**：`DDNS_DOMAIN`、`AUTH_TOKEN`、`ADMIN_PASSWORD`
3. **部署 `worker.js`**
4. **添加 Worker 路由**：`*.dns.域名/*`（Zone: `域名`）
5. **添加 DNS 记录**：`*.dns.域名`（橙云 Proxied）
6. **Lucky 里配 Webhook**：URL / 方法 / 请求头 / 请求体（见第五节）
7. **打开管理页** `https://proxy.<你的worker>.workers.dev/admin` 或 `http://任意前缀.dns.域名/admin`，输入 `ADMIN_PASSWORD` 登录
8. **输入前缀 → 生成配置 → 复制到 Lucky → 保存**
9. **点「刷新列表」**确认端口和跳转目标已出现

## 九、管理页功能

- 登录（密码 = `ADMIN_PASSWORD`，登录态存 sessionStorage，刷新不丢，关标签页失效）
- 输入前缀生成 Lucky Webhook 配置（一键复制）
- 已配置列表：前缀 / 端口 / 跳转目标 / 访问地址 / 更新时间 / 删除
- 「删除」只清 KV；**若 Lucky 里对应 Webhook 还在跑，下次上报会重新写回来**，要彻底删需先在 Lucky 删掉该 Webhook

## 十、已知限制与代价

1. **只能用 `http://`**：`*.dns.域名` 是二级子域，Cloudflare 免费证书不覆盖，HTTPS 握手会失败。若想用 HTTPS，需在 Cloudflare 开 **Total TLS**，或改用一级子域（`piweb.域名`，证书覆盖 `*.域名`）
2. **跳转后地址栏变成 `IP:端口`**：与域名不同源，cookie / localStorage 不通用，**登录态会因 IP 或端口变化而失效，需要重登一次**（IP 和端口都不变时，登录态是保留的）
3. **无法改成反向代理**：Cloudflare Workers 出站请求只允许标准端口（HTTP: 80/8080/8880/2052/2082/2086/2095，HTTPS: 443/2053/2083/2087/2096/8443），22843 这类端口 fetch 不到，所以只能用 302
4. **AUTH_TOKEN 明文传输**（因为走 http）
5. **KV 写入量**：免费额度 1000 次/天，Lucky 上报频率远用不完

## 十一、排错对照表

| 现象                                                       | 原因 / 处理                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `{"error":"服务器配置错误","detail":"缺少 XXX 环境变量"}`  | 环境变量没配或删了，补上并重新部署                           |
| `{"error":"服务器配置错误","detail":"缺少 proxy KV 绑定"}` | KV 绑定名不是 `proxy`                                        |
| 点登录按钮毫无反应                                         | 页面 JS 语法错误（历史 bug：模板字符串里的 `\n` 被提前转义，已修复） |
| 访问域名直接进了管理页                                     | 历史 bug：`path === '/'` 被管理页无条件截获，已修复为「DDNS 子域根路径走跳转」 |
| 跳到目标后返回 `403 Untrusted request`                     | 目标服务（如 Next.js dev server）做了 Host 校验，只认 IP/localhost。用 IP 跳转即可绕过，或改目标服务的 Host 白名单 / 改用生产模式 |
| 列表里看不到刚配的前缀                                     | 历史 bug：前缀是写死的，已改为遍历 KV。若仍看不到，等几秒（KV 有传播延迟） |
| `xxx.dns.域名:22843` 连不上                                | 橙云域名 + 非标准端口，Cloudflare 不代理，属正常现象，必须走 Worker 跳转 |
| 跳转后打不开                                               | 检查：① 路由器端口映射；② 目标服务是否在监听；③ KV 里的 `global:host` 是否是最新 IP |
| 换了网络/端口后跳转失败                                    | Lucky 没触发上报。确认 Webhook 的触发条件，必要时手动保存一次配置 |

## 十二、HTTPS 方案（备选，未采用）

若将来要 HTTPS + 稳定登录态（地址栏恒定），推荐 **Cloudflare Tunnel**：家里跑 `cloudflared`，把域名直接映射到 `localhost:<端口>`：

```yaml
ingress:
  - hostname: piweb.dns.域名
    service: http://localhost:22843
  - service: http_status:404
```

优点：地址栏永远是域名（cookie 永久有效）、无需端口映射、支持任意端口、可上 HTTPS。
代价：家里要常驻 `cloudflared` 进程，且二级子域仍需 Total TLS 才能用 HTTPS。
