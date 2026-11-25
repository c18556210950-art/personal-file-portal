# Personal File Portal

在浏览器统一查看多台 Windows 电脑上登记的文件夹。服务器用 SQLite 保存文件名、目录结构、大小和修改时间。电脑离线时目录仍可浏览，原文件在预览或下载时由它所在的电脑经 HTTPS 转发。

门户提供详细信息列表、目录内搜索、排序、单文件预览和下载，以及浏览器端 Markdown 渲染。Agent 使用文件系统事件合并更新受影响的目录，可用网页撤下已登记的目录。每台设备拥有独立的连接凭证。

## Windows Agent

使用 Python 3.11 或更新版本和 PowerShell。在仓库目录执行以下命令。

```powershell
python -m pip install -r requirements.txt
New-Item -ItemType Directory -Path "$env:LOCALAPPDATA\PersonalFilePortal" -Force
```

管理员向每台设备发放独立的 `agent.json`。将文件保存到 `%LOCALAPPDATA%\PersonalFilePortal\agent.json`，并将下面的示例字段替换为真实值。首次部署可用 `python -c "import secrets; print(secrets.token_hex(16)); print(secrets.token_urlsafe(32))"` 生成设备 ID 和令牌。

```json
{
  "url": "https://files.example.org/files/",
  "device": "replace-with-32-lowercase-hex-characters",
  "token": "replace-with-device-token",
  "namespaceRoots": true
}
```

```powershell
python agent.py add "C:\path\to\project"
python agent.py run
```

先运行前台进程验证连接。在其他终端运行 `python agent.py status`。确认连通后退出前台进程，再从 PowerShell 运行 `./install-startup.ps1`，为当前用户设置登录后自动启动。脚本使用当前环境的 `pythonw.exe`。Windows 管理员也可以选择 `-AtBoot`，并验证后台帐号能读取所登记的目录。

`python agent.py add .` 登记当前工作目录，`list` 列出本机登记，`remove <路径>` 撤下目录。也可以在门户首页使用「移除查看」。

## 自托管服务器

服务器需要 Node.js 24。创建一个私有数据目录，并在该目录外保存一份私有服务器配置。下面的 JSON 作为字段模板。

```json
{
  "database": "/var/lib/personal-file-portal/index.sqlite",
  "port": 18786,
  "origin": "https://files.example.org",
  "passwordHash": "sha256-hex-of-browser-password",
  "device": "replace-with-first-device-id",
  "deviceName": "Windows",
  "agentHash": "sha256-hex-of-Bearer-space-and-first-device-token",
  "additionalDevices": []
}
```

使用随机网页登录口令。以 UTF‑8 计算网页登录口令的 SHA‑256，设备令牌哈希计算的是完整的 `Bearer <token>` 字符串，结果均使用 64 位十六进制。额外设备的配置项格式为 `{"id":"设备 ID","name":"显示名","hash":"设备哈希"}`。设备 ID 与相应 Windows 配置一致。

```sh
PORTAL_CONFIG=/etc/personal-file-portal/config.json node server.mjs
```

Node 服务绑定 `127.0.0.1:18786`。在 HTTPS 虚拟主机中转发 `/files/`，保持完整路径并关闭请求与响应缓冲。生产环境可用 systemd 运行服务，服务帐号需要读取专用配置并可写 SQLite 数据目录。

```nginx
location ^~ /files/ {
    proxy_pass http://127.0.0.1:18786;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_max_temp_file_size 0;
    client_max_body_size 0;
    proxy_read_timeout 95s;
    proxy_send_timeout 95s;
}
```

验证时先用两台设备各登记一个测试目录，确认它们独立显示在线状态并能下载。停止一台 Agent，确认该台的目录索引仍可浏览，另一台设备继续提供文件。

Markdown 解析器随项目分发，许可证见 [markdown-it.LICENSE.txt](markdown-it.LICENSE.txt)。
