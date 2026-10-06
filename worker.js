// ==================== 常量定义 ====================
const SUBDOMAIN_REGEX = /^[a-zA-Z0-9-]{1,63}$/;
const MIN_PORT = 1;
const MAX_PORT = 65535;
const REQUEST_TIMEOUT = 30000;

// ==================== 辅助函数 ====================

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function isValidSubdomain(sub) {
  if (typeof sub !== 'string') return false;
  return SUBDOMAIN_REGEX.test(sub);
}

function isValidPort(port) {
  const num = Number(port);
  return Number.isInteger(num) && num >= MIN_PORT && num <= MAX_PORT;
}

/**
 * 解析 Lucky 上报的地址：支持纯 IPv4 / IPv6 / 域名，
 * 也兼容 "IP:端口" 形式（对应 Lucky 的 #{ipAddr}）。
 */
function parseHostValue(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 253) return null;
  
  // IPv4:端口
  const withPort = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
  if (withPort) {
    const portNum = Number(withPort[2]);
    if (!isValidPort(portNum)) return null;
    return { host: withPort[1], port: portNum };
  }
  
  if (!/^[0-9a-zA-Z.\-:]+$/.test(value)) return null;
  return { host: value, port: null };
}

function extractPathAndSearch(urlString) {
  try {
    const url = new URL(urlString);
    return { pathname: url.pathname, search: url.search };
  } catch (e) {
    return { pathname: '/', search: '' };
  }
}

function verifyBearerToken(request, expectedToken) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;
  const provided = authHeader.replace(/^Bearer\s+/i, '');
  return constantTimeEqual(provided, expectedToken);
}

function extractSubdomainFromHost(host) {
  if (!host) return null;
  const hostname = host.split(':')[0];
  const parts = hostname.split('.');
  return parts.length >= 2 ? parts[0] : null;
}

// DDNS 域名 -> IPv4 的短期缓存（同一 isolate 内复用）
let ddnsIpCache = { host: null, ip: null, expireAt: 0 };

// DoH 查询端点，按顺序回退
const DOH_ENDPOINTS = [
  'https://1.1.1.1/dns-query',
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve'
];

/**
 * 通过 DoH 解析 A 记录（JSON 格式），失败时逐个端点回退。
 */
async function queryDohARecord(host) {
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const res = await fetch(
        endpoint + '?name=' + encodeURIComponent(host) + '&type=A',
        { headers: { accept: 'application/dns-json' } }
      );
      if (!res.ok) continue;
      
      const data = await res.json();
      const answer = Array.isArray(data.Answer) ? data.Answer : [];
      const record = answer.find(a => a.type === 1 && typeof a.data === 'string');
      if (record) return record;
    } catch (e) {
      // 换下一个端点
    }
  }
  return null;
}

/**
 * 解析 DDNS 域名当前的 IPv4 地址。
 * 目的：目标服务只认 IP/localhost 这类 Host，用域名访问会被 403 拒绝。
 */
async function resolveHostIPv4(host) {
  const now = Date.now();
  if (ddnsIpCache.host === host && ddnsIpCache.ip && ddnsIpCache.expireAt > now) {
    return ddnsIpCache.ip;
  }
  
  const record = await queryDohARecord(host);
  if (!record) return null;
  
  const ttlSec = Math.max(30, Math.min(Number(record.TTL) || 60, 300));
  ddnsIpCache = { host: host, ip: record.data, expireAt: now + ttlSec * 1000 };
  return record.data;
}

// ==================== HTML 管理页面 ====================

const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Lucky Webhook 配置生成器</title>
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px; 
      margin: 0 auto; 
      padding: 20px; 
      background: #f8f9fa; 
    }
    h1 { 
      color: #2c3e50; 
      text-align: center; 
      margin: 0 0 24px; 
      font-size: 26px; 
    }
    .card {
      background: #fff; 
      padding: 24px; 
      border-radius: 12px; 
      box-shadow: 0 4px 12px rgba(0,0,0,0.08); 
      margin-bottom: 24px;
    }
    .login-card {
      max-width: 400px;
      margin: 50px auto;
    }
    .label {
      display: block;
      margin-bottom: 8px;
      font-weight: 600;
      color: #34495e;
      font-size: 14px;
    }
    .input {
      width: 100%;
      padding: 12px 16px;
      border: 1px solid #dfe6e9;
      border-radius: 8px;
      font-size: 15px;
      background: #fafafa;
    }
    .input:focus {
      outline: none;
      border-color: #0984e3;
      box-shadow: 0 0 0 3px rgba(9,132,227,0.15);
    }
    .btn {
      width: 100%;
      padding: 14px 20px;
      background: #0984e3;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn:hover { background: #74b9ff; }
    .btn:active { transform: scale(0.98); }
    .btn.copy { background: #00b894; margin-top: 16px; }
    .btn.copy:hover { background: #55efc4; }
    .btn.secondary { background: #95a5a6; margin-top: 8px; }
    .btn.secondary:hover { background: #7f8c8d; }
    .btn.danger { background: #e74c3c; margin-top: 8px; }
    .btn.danger:hover { background: #c0392b; }
    .btn-del {
      padding: 4px 12px;
      background: #e74c3c;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    }
    .btn-del:hover { background: #c0392b; }
    .section {
      margin: 24px 0;
      padding: 16px;
      background: #f8f9fa;
      border-radius: 8px;
      border: 1px solid #e9ecef;
    }
    .section-title {
      font-size: 15px;
      font-weight: 600;
      color: #2d3436;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
    }
    .section-title span {
      display: inline-block;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #00b894;
      margin-right: 8px;
    }
    .code-block {
      position: relative;
      margin-top: 8px;
    }
    .code {
      background: #2d3436;
      color: #dfe6e9;
      padding: 16px;
      border-radius: 8px;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 13px;
      white-space: pre-wrap;
      overflow-x: auto;
      max-height: 300px;
      overflow-y: auto;
    }
    .code-copy {
      position: absolute;
      top: 8px;
      right: 8px;
      padding: 6px 12px;
      background: #636e72;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
    }
    .code-copy:hover { background: #747d8c; }
    .hint {
      margin-top: 12px;
      padding: 12px;
      background: #fff3cd;
      border-left: 4px solid #ffc107;
      border-radius: 4px;
      font-size: 13px;
      color: #856404;
    }
    .result {
      margin-top: 16px;
      padding: 12px;
      border-radius: 8px;
      font-size: 14px;
    }
    .result.success {
      background: #d4edda;
      color: #155724;
      border: 1px solid #c3e6cb;
    }
    .result.error {
      background: #f8d7da;
      color: #721c24;
      border: 1px solid #f5c6cb;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 16px;
      font-size: 14px;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #eee;
    }
    th {
      color: #0984e3;
      background: #f8f9fa;
      font-weight: 600;
    }
    a {
      color: #0984e3;
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <!-- 登录卡片 -->
  <div class="card login-card" id="loginCard">
    <h1>🔐 登录管理页面</h1>
    <p style="text-align:center;color:#636e72;margin-bottom:24px">请输入管理密码</p>
    <div>
      <label class="label">管理密码</label>
      <input type="password" id="loginPassword" class="input" placeholder="输入管理密码">
    </div>
    <button class="btn" id="loginBtn" style="margin-top:16px">登 录</button>
    <div class="result" id="loginError" style="display:none"></div>
  </div>

  <!-- 管理卡片 -->
  <div id="adminContent" class="hidden">
    <div class="card">
      <h1>🔧 Lucky Webhook 配置生成器</h1>
      <p style="text-align:center;color:#636e72;margin-bottom:24px">输入前缀，生成 Lucky Webhook 配置，一键复制到 Lucky</p>
      
      <div>
        <label class="label">子域名前缀（例如: nas、alist、web）</label>
        <input type="text" id="sub" class="input" placeholder="输入前缀，只能是字母数字和短横线" maxlength="63">
      </div>
      <button class="btn" id="generateBtn" style="margin-top:16px">生成 Lucky Webhook 配置</button>
      <button class="btn danger" id="logoutBtn">退出登录</button>
    </div>

    <div id="outputCard" class="card hidden">
      <h2 style="color:#2c3e50;margin:0 0 20px">✅ 配置已生成</h2>
      <div class="section">
        <div class="section-title"><span></span>请在 Lucky 中填入以下内容</div>
        <div class="code-block">
          <div class="code" id="configText">// 请在此处填入以下内容到 Lucky 的 Webhook 设置</div>
          <button class="btn copy" id="copyBtn">📋 一键复制全部配置</button>
        </div>
        <div class="hint">
          <strong>步骤：</strong>打开 Lucky → 穿透任务 → Webhook 设置 → 粘贴配置 → 保存（Lucky 会立即测试一次并自动更新 KV）
        </div>
      </div>
      <div class="section">
        <div class="section-title"><span></span>已生成的配置详情</div>
        <table>
          <tr><th width="120">配置项</th><th>值</th></tr>
          <tr><td><strong>URL</strong></td><td><code id="cfg-url"></code></td></tr>
          <tr><td><strong>请求方法</strong></td><td><code id="cfg-method">POST</code></td></tr>
          <tr><td><strong>请求头</strong></td><td><code id="cfg-header"></code></td></tr>
          <tr><td><strong>请求体</strong></td><td><code id="cfg-body"></code></td></tr>
          <tr><td><strong>说明</strong></td><td>Lucky 会将 <strong>#{port}</strong> 自动替换为当前穿透端口</td></tr>
        </table>
      </div>
      <div class="result" id="resultMsg" style="display:none"></div>
    </div>

    <div class="card">
      <h2 style="color:#2c3e50;margin:0 0 16px">📊 已配置的子域名列表</h2>
      <button class="btn secondary" id="refreshBtn">刷新列表</button>
      <table>
        <thead>
          <tr>
            <th>前缀</th>
            <th>端口</th>
            <th>跳转目标</th>
            <th>访问地址</th>
            <th>更新时间</th>
            <th width="80">操作</th>
          </tr>
        </thead>
        <tbody id="portTable">
          <tr><td colspan="6" style="text-align:center;color:#95a5a6">暂无配置</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    // 页面加载时由 Worker 动态注入配置
    const WORKER_CONFIG = __WORKER_CONFIG_JSON__;
    
    // 尝试从 sessionStorage 恢复登录状态
    let loggedIn = false;
    
    (function init() {
      const storedPassword = sessionStorage.getItem('admin_password_verified');
      if (storedPassword === 'true') {
        loggedIn = true;
        showAdminContent();
      }
    })();
    
    // 登录处理
    document.getElementById('loginBtn').addEventListener('click', function() {
      const password = document.getElementById('loginPassword').value;
      const errorDiv = document.getElementById('loginError');
      
      fetch('/__admin_check_password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password })
      })
      .then(res => res.json())
      .then(data => {
        if (data.ok) {
          sessionStorage.setItem('admin_password_verified', 'true');
          loggedIn = true;
          errorDiv.style.display = 'none';
          document.getElementById('loginCard').classList.add('hidden');
          showAdminContent();
        } else {
          errorDiv.textContent = data.error || '密码错误';
          errorDiv.className = 'result error';
          errorDiv.style.display = 'block';
        }
      })
      .catch(() => {
        errorDiv.textContent = '网络错误';
        errorDiv.className = 'result error';
        errorDiv.style.display = 'block';
      });
    });
    
    // 支持回车登录
    document.getElementById('loginPassword').addEventListener('keypress', function(e) {
      if (e.key === 'Enter') document.getElementById('loginBtn').click();
    });
    
    // 登出
    document.getElementById('logoutBtn').addEventListener('click', function() {
      sessionStorage.removeItem('admin_password_verified');
      loggedIn = false;
      location.reload();
    });
    
    function showAdminContent() {
      document.getElementById('loginCard').classList.add('hidden');
      document.getElementById('adminContent').classList.remove('hidden');
      refreshPortList();
    }
    
    async function api(endpoint, options = {}) {
      // 用相对路径：始终请求当前访问管理页所用的域名，避免硬编码
      const response = await fetch(endpoint, {
        ...options,
        headers: {
          'Authorization': 'Bearer ' + WORKER_CONFIG.authToken,
          'Content-Type': 'application/json'
        }
      });
      return response.json();
    }
    
    // 生成配置
    document.getElementById('generateBtn').addEventListener('click', function() {
      const sub = document.getElementById('sub').value.trim();
      
      if (!sub || !/^[a-zA-Z0-9-]+$/.test(sub)) {
        alert('前缀无效：只能包含字母、数字和短横线');
        return;
      }
      
      const configBody = {
        sub: sub,
        host: '#{ip}',
        port: '#{port}'
      };
      
      // Webhook 地址使用「前缀 + DDNS 域名」，而不是管理页所在的 workers.dev 域名
      // 注意：*.dns.maple521.cc.cd 是二级子域，Cloudflare 免费证书不覆盖，只能用 http
      const webhookOrigin = WORKER_CONFIG.ddnsDomain
        ? 'http://' + sub + '.' + WORKER_CONFIG.ddnsDomain
        : location.origin;
      
      const config = {
        url: webhookOrigin + '/__update_port',
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + WORKER_CONFIG.authToken },
        body: JSON.stringify(configBody)
      };
      
      const configTextContent = 
        '========================================\\n' +
        'Lucky Webhook 配置\\n' +
        '========================================\\n' +
        'URL: ' + config.url + '\\n' +
        '方法: ' + config.method + '\\n' +
        '请求头: Authorization: Bearer ' + WORKER_CONFIG.authToken + '\\n' +
        '请求体: ' + config.body + '\\n' +
        '备注: Lucky 会自动替换 #{ip} 和 #{port} 为当前 STUN 穿透的公网 IP 与端口\\n' +
        '========================================';
      
      document.getElementById('configText').textContent = configTextContent;
      document.getElementById('cfg-url').textContent = config.url;
      document.getElementById('cfg-method').textContent = config.method;
      document.getElementById('cfg-header').textContent = 'Authorization: Bearer ' + WORKER_CONFIG.authToken;
      document.getElementById('cfg-body').textContent = config.body;
      
      document.getElementById('outputCard').classList.remove('hidden');
      
      api('/__get_port?sub=' + sub)
        .then(data => {
          const resultDiv = document.getElementById('resultMsg');
          if (data && data.port !== undefined) {
            resultDiv.textContent = '✅ 该子域名已有配置，端口: ' + data.port + 
              ', 上次更新: ' + (data.updated_at || '未知');
            resultDiv.className = 'result success';
            resultDiv.style.display = 'block';
          } else {
            resultDiv.style.display = 'none';
          }
        })
        .catch(() => {
          document.getElementById('resultMsg').style.display = 'none';
        });
      
      refreshPortList();
    });
    
    document.getElementById('copyBtn').addEventListener('click', function() {
      const text = document.getElementById('configText').textContent;
      navigator.clipboard.writeText(text)
        .then(() => alert('✅ 配置已复制到剪贴板！'))
        .catch(() => alert('复制失败，请手动复制'));
    });
    
    function refreshPortList() {
      const table = document.getElementById('portTable');
      
      api('/__list_ports')
        .then(data => {
          const list = (data && Array.isArray(data.results)) ? data.results : [];
          if (!list.length) {
            table.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#95a5a6">暂无配置</td></tr>';
            return;
          }
          let rows = '';
          list.forEach(item => {
            const domain = item.sub + '.' + WORKER_CONFIG.ddnsDomain;
            const target = item.host ? (item.host + ':' + item.port) : '-';
            rows += '<tr><td><strong>' + item.sub + '</strong></td>' +
              '<td>' + item.port + '</td>' +
              '<td><code>' + target + '</code></td>' +
              '<td><a href="http://' + domain + '" target="_blank">' + domain + '</a></td>' +
              '<td>' + (item.updated_at ? new Date(item.updated_at).toLocaleString() : '-') + '</td>' +
              '<td><button class="btn-del" data-sub="' + item.sub + '">删除</button></td></tr>';
          });
          table.innerHTML = rows;
        })
        .catch(() => {
          table.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#e74c3c">列表加载失败</td></tr>';
        });
    }
    
    // 删除某条配置（事件委托，因为行是动态生成的）
    document.getElementById('portTable').addEventListener('click', function(e) {
      const btn = e.target.closest ? e.target.closest('.btn-del') : null;
      if (!btn) return;
      
      const sub = btn.getAttribute('data-sub');
      if (!confirm('确定删除「' + sub + '」吗？删除后该子域名将无法跳转。')) return;
      
      api('/__delete_port', {
        method: 'POST',
        body: JSON.stringify({ sub: sub })
      })
      .then(data => {
        if (data && data.ok) {
          refreshPortList();
        } else {
          alert('删除失败：' + ((data && data.error) || '未知错误'));
        }
      })
      .catch(() => alert('删除失败，请检查网络'));
    });
    
    document.getElementById('refreshBtn').addEventListener('click', refreshPortList);
  </script>
</body></html>`;

// ==================== 业务逻辑 ====================

async function handleAdminPasswordCheck(request, env) {
  const { ADMIN_PASSWORD } = env;
  if (!ADMIN_PASSWORD) {
    return json(500, { ok: false, error: '未设置 ADMIN_PASSWORD 环境变量' });
  }
  
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { ok: false, error: 'JSON 解析失败' });
  }
  
  const password = body && body.password;
  if (typeof password !== 'string' || password.length === 0 || password.length > 128) {
    return json(400, { ok: false, error: '密码不能为空' });
  }
  
  if (constantTimeEqual(password, ADMIN_PASSWORD)) {
    return json(200, { ok: true });
  } else {
    return json(401, { ok: false, error: '密码错误' });
  }
}

async function handleUpdatePort(request, kv, authToken) {
  if (!verifyBearerToken(request, authToken)) {
    return json(401, { ok: false, error: '鉴权失败' });
  }
  
  if (request.method !== 'POST') {
    return json(405, { ok: false, error: '方法不支持' });
  }
  
  let jsonBody;
  try {
    jsonBody = await request.json();
  } catch (e) {
    return json(400, { ok: false, error: 'JSON 解析失败' });
  }
  
  if (!jsonBody) {
    return json(400, { ok: false, error: '请求体为空' });
  }
  
  const entries = Array.isArray(jsonBody) ? jsonBody : [jsonBody];
  const results = [];
  const timestamp = new Date().toISOString();
  
  for (const entry of entries) {
    const { sub, port, host } = entry;
    
    if (!sub || !isValidSubdomain(String(sub))) {
      results.push({ sub: sub, error: '子域名格式非法' });
      continue;
    }
    
    // 可选：Lucky 上报的公网地址（#{ip} 或 #{ipAddr}）
    let hostValue = null;
    let hostPort = null;
    if (host !== undefined && host !== null && String(host).trim() !== '') {
      const parsed = parseHostValue(String(host));
      if (!parsed) {
        results.push({ sub: sub, error: 'host 格式非法', host: host });
        continue;
      }
      hostValue = parsed.host;
      hostPort = parsed.port;
    }
    
    const portNum = hostPort || Number(port);
    if (!isValidPort(portNum)) {
      results.push({ sub: sub, error: '端口值非法', port: port });
      continue;
    }
    
    await kv.put(`${sub}:port`, String(portNum), { metadata: { updated_at: timestamp } });
    if (hostValue) {
      // 所有服务共用同一个公网 IP，只存一个全局键
      await kv.put('global:host', hostValue);
    }
    
    results.push({ ok: true, sub: sub, port: portNum, host: hostValue, updated_at: timestamp });
  }
  
  const hasError = results.some(r => r.error);
  return json(hasError ? 400 : 200, {
    ok: !hasError,
    results: results
  });
}

async function handleGetPort(request, kv, authToken) {
  if (!verifyBearerToken(request, authToken)) {
    return json(401, { error: '鉴权失败' });
  }
  
  if (request.method !== 'GET') {
    return json(405, { error: '方法不支持' });
  }
  
  const url = new URL(request.url);
  const sub = url.searchParams.get('sub');
  
  if (!sub || !isValidSubdomain(sub)) {
    return json(400, { error: '子域名格式非法' });
  }
  
  const { value: portStr, metadata } = await kv.getWithMetadata(`${sub}:port`);
  const subHost = await kv.get(`${sub}:host`);
  const globalHost = await kv.get('global:host');
  const updatedAt = (metadata && metadata.updated_at) || null;
  
  if (!portStr) {
    return json(404, { error: '未配置的子域名', detail: `"${sub}" 未配置` });
  }
  
  const port = Number(portStr);
  if (!isValidPort(port)) {
    return json(500, { error: '端口值非法' });
  }
  
  return json(200, { sub: sub, port: port, host: subHost || globalHost || null, updated_at: updatedAt });
}

async function handleListPorts(request, kv, authToken) {
  if (!verifyBearerToken(request, authToken)) {
    return json(401, { error: '鉴权失败' });
  }
  
  if (request.method !== 'GET') {
    return json(405, { error: '方法不支持' });
  }
  
  // 遍历 KV 中所有 "<前缀>:port" 键，更新时间取自键的 metadata
  const entries = [];
  let cursor;
  do {
    const listed = await kv.list({ cursor: cursor, limit: 1000 });
    for (const key of listed.keys) {
      if (key.name.endsWith(':port')) {
        entries.push({
          sub: key.name.slice(0, -':port'.length),
          updated_at: (key.metadata && key.metadata.updated_at) || null
        });
      }
    }
    cursor = listed.list_complete ? null : listed.cursor;
  } while (cursor);
  
  const globalHost = await kv.get('global:host');
  const results = await Promise.all(entries.map(async (entry) => {
    const portStr = await kv.get(`${entry.sub}:port`);
    const subHost = await kv.get(`${entry.sub}:host`);
    return { sub: entry.sub, port: Number(portStr), host: subHost || globalHost || null, updated_at: entry.updated_at };
  }));
  
  const valid = results.filter(r => isValidPort(r.port));
  valid.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  
  return json(200, { ok: true, count: valid.length, results: valid });
}

async function handleDeletePort(request, kv, authToken) {
  if (!verifyBearerToken(request, authToken)) {
    return json(401, { error: '鉴权失败' });
  }
  
  if (request.method !== 'POST') {
    return json(405, { error: '方法不支持' });
  }
  
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { error: 'JSON 解析失败' });
  }
  
  const sub = body && body.sub;
  if (!sub || !isValidSubdomain(String(sub))) {
    return json(400, { error: '子域名格式非法' });
  }
  
  await kv.delete(`${sub}:port`);
  await kv.delete(`${sub}:host`);
  
  return json(200, { ok: true, sub: sub });
}

async function handleProxyRedirect(request, ddnsDomain, kv) {
  const host = request.headers.get('Host');
  const sub = extractSubdomainFromHost(host);
  
  if (!sub || !isValidSubdomain(sub)) {
    return json(400, { error: '子域名格式非法' });
  }
  
  const portStr = await kv.get(`${sub}:port`);
  if (!portStr) {
    return json(404, { error: '未配置的子域名', detail: `"${sub}" 未配置` });
  }
  
  const port = Number(portStr);
  if (!isValidPort(port)) {
    return json(500, { error: '端口值非法' });
  }
  
  const { pathname, search } = extractPathAndSearch(request.url);
  
  // 跳转目标优先级：本前缀专用 host > 全局 host > DoH 解析出的 IP > DDNS 域名
  const subHost = parseHostValue(await kv.get(`${sub}:host`));
  const globalHost = parseHostValue(await kv.get('global:host'));
  const reported = subHost || globalHost;
  let targetHost = reported ? reported.host : null;
  if (!targetHost) {
    targetHost = (await resolveHostIPv4(ddnsDomain)) || ddnsDomain;
  }
  const targetPort = (reported && reported.port) || port;
  
  // IPv6 地址需要方括号
  const urlHost = targetHost.includes(':') ? `[${targetHost}]` : targetHost;
  const redirectUrl = `http://${urlHost}:${targetPort}${pathname}${search}`;
  
  return Response.redirect(redirectUrl, 302);
}

// ==================== 主入口 ====================

export default {
  async fetch(request, env, ctx) {
    const { DDNS_DOMAIN, AUTH_TOKEN, ADMIN_PASSWORD, proxy: kv } = env;
    
    if (!DDNS_DOMAIN) {
      return json(500, { error: '服务器配置错误', detail: '缺少 DDNS_DOMAIN 环境变量' });
    }
    if (!AUTH_TOKEN) {
      return json(500, { error: '服务器配置错误', detail: '缺少 AUTH_TOKEN 环境变量' });
    }
    if (!kv) {
      return json(500, { error: '服务器配置错误', detail: '缺少 proxy KV 绑定' });
    }
    
    const url = new URL(request.url);
    const path = url.pathname;
    const hostname = (request.headers.get('Host') || '').split(':')[0].toLowerCase();
    // 是否通过 DDNS 子域访问（例如 fnos.dns.maple521.cc.cd）
    const ddnsHost = String(DDNS_DOMAIN).split(':')[0].toLowerCase();
    const isDdnsSubdomainHost = hostname !== ddnsHost && hostname.endsWith('.' + ddnsHost);
    
    // 管理页面：固定走 /admin；DDNS 子域的根路径留给重定向逻辑
    if (path === '/admin' || (path === '/' && !isDdnsSubdomainHost)) {
      // 动态注入配置到页面
      const workerUrl = url.origin;
      const injectedConfig = {
        workerUrl: workerUrl,
        ddnsDomain: DDNS_DOMAIN,
        authToken: AUTH_TOKEN,
        adminPasswordRequired: !!ADMIN_PASSWORD
      };
      
      const htmlContent = ADMIN_PAGE.replace(
        '__WORKER_CONFIG_JSON__',
        () => JSON.stringify(injectedConfig).replace(/</g, '\\u003c')
      );
      
      return new Response(htmlContent, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
    
    // 管理密码验证端点
    if (path === '/__admin_check_password') {
      return handleAdminPasswordCheck(request, env);
    }
    
    // API 端点
    if (path === '/__update_port') {
      return handleUpdatePort(request, kv, AUTH_TOKEN);
    }
    
    if (path === '/__get_port') {
      return handleGetPort(request, kv, AUTH_TOKEN);
    }
    
    if (path === '/__list_ports') {
      return handleListPorts(request, kv, AUTH_TOKEN);
    }
    
    if (path === '/__delete_port') {
      return handleDeletePort(request, kv, AUTH_TOKEN);
    }
    
    // 默认：重定向
    return handleProxyRedirect(request, DDNS_DOMAIN, kv);
  }
};
