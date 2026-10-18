# Grantloom

**Google OAuth：你只是想登录，不是想应聘认证协议研究员。**

[English](https://github.com/ryoshin0830/grantloom/blob/main/README.md) · [日本語](https://github.com/ryoshin0830/grantloom/blob/main/README.ja.md) · **简体中文**

本来只想写个脚本读一下日历。结果浏览器开了六个标签页，桌上摆着三种凭据，还有一个不敢碰的 refresh token。日历没读到，OAuth 快读博了。

Grantloom 帮你办理这套授权手续：**带上自己的 Google OAuth 客户端，在浏览器里同意授权，把验证后的凭据保存到 1Password、私有 JSON 文件或环境变量文件**。脚本可以通过子进程环境变量使用凭据；AI 助手可以通过 CLI、MCP 或随附的 Skill 协助操作。

这是与 Google 无隶属关系的独立项目。没有 Grantloom 自建的托管认证服务，也不用注册我们的账号。虽然名字里有 Grant，但不发科研经费。发的是你同意授予的权限。

## 目录

- [它到底能干什么？](#它到底能干什么)
- [完成第一次授权](#完成第一次授权)
- [文件放哪里，里面是什么？](#文件放哪里里面是什么)
- [OAuth 客户端有三种输入方式](#oauth-客户端有三种输入方式)
- [获得的凭据也有三个去处](#获得的凭据也有三个去处)
- [scope：只领需要的钥匙](#scope只领需要的钥匙)
- [全部 CLI 命令](#全部-cli-命令)
- [CLI 参数速查](#cli-参数速查)
- [MCP：给 AI 助手的七件工具](#mcp给-ai-助手的七件工具)
- [随附的 agent Skill](#随附的-agent-skill)
- [授权时，后台做了什么？](#授权时后台做了什么)
- [遇到问题怎么办？](#遇到问题怎么办)
- [开发与许可证](#开发与许可证)

## 它到底能干什么？

| 你想要…… | Grantloom 负责…… |
| --- | --- |
| 给使用 Gmail、Drive、Sheets、Calendar 等 Google API 的脚本授权 | 按所选 scope 发起浏览器授权，核对真实账号和实际权限 |
| 不把 token 粘进聊天窗口或终端输出 | 只返回元数据，凭据直接进入指定存储位置 |
| 把工作和个人用途分开 | 用不同名称的 profile 保存客户端引用、账号、scope 和存储目标 |
| 获得新的 access token | 刷新已有 profile，验证结果，并更新原存储位置 |
| 让自己的脚本使用凭据 | 用 `exec` 把凭据注入子进程环境 |
| 让 AI 助手协调授权流程 | 提供 CLI、七个 MCP 工具和 Skill |
| 查询可以申请哪些权限 | 列出常用 scope 候选，可选查 API Discovery 和已启用 API |

它管理的是**授权与凭据**，不会自己读取邮件、发送邮件、编辑表格或整理网盘。这些工作由使用凭据的程序完成。Grantloom 是酒店发钥匙的前台，不是包办保洁、早餐和接机的全体员工。

它不会启用 Google API、绕过 Workspace 政策、在后台自动刷新，也不会因为你删除本地文件就撤销 token。没有“打印 token”命令，也没有能执行任意命令的 MCP 工具。

### 六个小术语。不考试，放心。

| 术语 | 人话版 |
| --- | --- |
| OAuth 客户端 | 告诉 Google 这是哪个应用，不是你的 Google 账号 |
| 账号 | 正在授予访问权的 Google 用户 |
| scope | 向该用户申请的某项权限 |
| access token | 程序调用 API 时使用的、有期限的凭据 |
| refresh token | 在其有效期间，无须重复浏览器授权即可换取新 access token 的凭据 |
| profile | 给一组账号、客户端、scope 和存储设置起的本地名称，以及保存的引用 |

## 完成第一次授权

### 1. 准备材料

- **Node.js 22 或更高版本**及 npm。
- Google 账号，以及一个你能配置的 Google Cloud 项目。
- Google OAuth 客户端。初次使用选**桌面应用（Desktop app）**最方便。
- 用于 Google 登录、多因素认证和授权同意的浏览器。
- 可选：[1Password CLI](https://developer.1password.com/docs/cli/get-started/)，用于保险库存储。

| 平台 | JSON / 环境变量凭据文件 | 1Password |
| --- | --- | --- |
| macOS / Linux | 支持 | 安装并配置 `op` 后支持 |
| Windows | 明确不支持 | 安装并配置 `op` 后支持 |

命令示例采用 bash/zsh 语法。Windows 请使用 1Password，并按自己的 shell 调整多行命令。Windows 仍会在本地保存 profile 元数据，保护依赖操作系统的用户目录权限。

### 2. 创建 Google OAuth 客户端

在自己的 Google Cloud 项目中：

1. 启用程序需要调用的 API。
2. 配置 OAuth 同意界面和受众；如果应用处于 Testing，将自己的账号添加为测试用户。
3. 创建类型为**桌面应用（Desktop app）**的 OAuth 客户端。
4. 下载 JSON，放到私有位置，例如 `$HOME/.config/google/desktop-client.json`。

该文件有一个 `installed` 对象，包含 `client_id`、`client_secret`，以及可选的 `project_id` 等字段。服务账号密钥是另一种凭据，不能用在这里。具体配置可参考 [Google 桌面 OAuth 官方指南](https://developers.google.com/identity/protocols/oauth2/native-app)。

放在代码仓库外。macOS/Linux 将下载文件放到示例路径后，可用以下命令设置权限。Grantloom 会读取输入文件，但不会替你修复原文件的权限。

```sh
mkdir -p "$HOME/.config/google"
chmod 700 "$HOME/.config/google"
chmod 600 "$HOME/.config/google/desktop-client.json"
```

### 3. 安装，或者用 npx 临时借用

```sh
npm install -g grantloom@0.1.0
grantloom --help
```

不想全局安装？运行 `npx --yes grantloom@0.1.0 auth`。下文的 `grantloom` 命令也都可以换成 `npx --yes grantloom@0.1.0`。

### 4. 你提出申请，Google 正式确认

```sh
grantloom auth \
  --client-json "$HOME/.config/google/desktop-client.json" \
  --account you@example.com \
  --scope gmail.readonly,calendar.readonly \
  --store json \
  --output "$HOME/.config/grantloom/credentials/personal.json" \
  --profile personal \
  --json
```

将 `you@example.com` 换成自己的账号。本指南中的路径和 item ID 都是示例，不是随包提供的个人配置。

Grantloom 会先显示账号、完整的请求 scope 和目标位置，再打开 Google 授权界面。选中指定账号，同意所需权限。在出现 `saved` 之前，请保持 CLI 运行。

在终端直接运行 `grantloom auth`，会依次询问客户端来源、账号、scope、存储类型、目标位置和 profile 名称。scope 留空表示只申请身份确认。非交互环境必须通过参数提供全部必填设置，缺失时返回 `INVALID_CONFIG`，退出码为 `2`。

浏览器没打开？手动打开显示的 Google 授权 URL。`--no-open` 只关闭自动打开，不跳过授权。回调服务运行在 CLI 所在机器上；通过 SSH 或容器使用时，需要确保浏览器能访问该机器的 loopback 回调。

### 5. 检查、刷新、交给脚本使用

```sh
grantloom status --profile personal --json
grantloom refresh --profile personal --json
grantloom exec --profile personal -- node ./your-google-api-script.mjs
```

最后一条命令需要你自己准备脚本；Grantloom 不会生成它。脚本能收到哪些环境变量，请看[全部 CLI 命令](#全部-cli-命令)。

## 文件放哪里，里面是什么？

一共有**三种东西**。如果全部叫 `credentials.json`，你得到的就不只是授权，还有一部需要自己破案的悬疑剧。

| 类型 | 谁创建？ | 示例位置 | 内容 |
| --- | --- | --- | --- |
| **OAuth 客户端输入** | 你 / Google Cloud | `~/.config/google/desktop-client.json` | 应用的 client ID、client secret、项目信息 |
| **profile** | Grantloom 保存成功后 | `~/.config/grantloom/personal.json` | 账号、scope、客户端来源和存储位置的引用；没有 token 或 client secret 的值 |
| **凭据记录** | Grantloom | `--output` 指定的位置，或 1Password 条目 | client ID/secret、access/refresh token、到期时间、账号、scope、验证时间 |

开头的 JSON 示例会产生这样的布局：

```text
~/.config/
├── google/
│   └── desktop-client.json        ← 自行提供的敏感输入
└── grantloom/
    ├── personal.json              ← profile：引用与元数据
    └── credentials/
        └── personal.json          ← 实际凭据：需要保密
```

选择 `--store env` 时，可以指定 `credentials/personal.env`。选择 `--store 1password` 时，凭据放在保险库里，本地仍保留 profile。原始客户端仍在你放置它的位置。

**凭据目标位置需要明确指定。** Grantloom 使用你的参数，或在交互时询问；不会默默选中上面的示例路径。

**profile 的默认位置：** `$HOME/.config/grantloom/<profile>.json`。设置 `GRANTLOOM_CONFIG_DIR` 可更换 profile 目录，但不会移动原始客户端，也不会更改 `--output` 指定的凭据位置。后续调用要使用相同设置。profile 名称为 1–63 个小写字母、数字或连字符，必须以字母或数字开头。

**保留原始客户端来源。** `status`、`refresh`、`exec` 都会重新读取它。文件必须继续可读；环境变量必须在每个进程中可用；1Password 来源需要可用的 `op` 权限。

**本地文件是明文，不会加密。** macOS/Linux 的 profile 和凭据文件使用私有权限（目录 `0700`、文件 `0600`）、原子替换及 symlink / 不安全路径检查。同一操作系统用户的其他进程仍可能读取它们。需要保险库存储时请选择 1Password。profile 也包含账号邮箱、路径等个人元数据，请不要公开。

不同账号或权限组合请使用不同的 profile 名称和凭据目标。目标位置已经有不同账号、客户端或 scope 的记录时，Grantloom 会拒绝写入。

## OAuth 客户端有三种输入方式

每次授权选**一种**。参数传递的是秘密放在哪里，不是秘密本身。

| 来源 | 参数 | 需要准备 |
| --- | --- | --- |
| Google 客户端 JSON 文件 | `--client-json PATH` | 可读取、带 `installed` 或 `web` 的 JSON |
| 环境变量 | `--client-env VARIABLE_NAME` | 内容为完整客户端 JSON 的变量 |
| 1Password 条目 | `--client-op-item ITEM_ID --op-vault VAULT_ID` | 有必需客户端字段且可访问的条目 |

用环境变量时，在本地读取 JSON 而不打印它，再传入**变量名**：

```sh
export GOOGLE_OAUTH_CLIENT_JSON="$(< "$HOME/.config/google/desktop-client.json")"
grantloom auth \
  --client-env GOOGLE_OAUTH_CLIENT_JSON \
  --account you@example.com --scope drive.readonly \
  --store json --output "$HOME/.config/grantloom/credentials/drive.json" \
  --profile drive
```

1Password 的默认字段标签是 `client_id`、`client_secret` 和可选的 `project_id`；默认客户端类型为 `installed`。已有字段名称不同，可以这样映射：

```sh
grantloom auth \
  --client-op-item OAUTH_CLIENT_ITEM_ID --op-vault CLIENT_VAULT_ID \
  --client-id-field username --client-secret-field credential \
  --client-project-field project_id --client-type installed \
  --account you@example.com --scope gmail.readonly \
  --store 1password --store-vault TOKEN_VAULT_ID \
  --title "Google OAuth personal" --profile personal
```

### 已经有 Web 客户端？

使用 JSON 文件或环境变量，并注册带明确固定端口和回调路径的 **HTTP IPv4 loopback** URI。`--redirect-uri` 必须与 `web.redirect_uris` 中的某个值完全一致。注册端口被占用时会报错，不会擅自换一个。

```sh
grantloom auth \
  --client-json "$HOME/.config/google/web-client.json" \
  --redirect-uri http://127.0.0.1:8765/oauth/callback \
  --account you@example.com --scope sheets.readonly \
  --store json --output "$HOME/.config/grantloom/credentials/sheets.json" \
  --profile sheets
```

Desktop 客户端使用可用的 `127.0.0.1` 端口，不接受 `--redirect-uri`。Web 客户端支持 `127.0.0.1` 或 `localhost`；此实现不支持 IPv6 或外部 HTTPS 回调。1Password 客户端来源没有注册 redirect 列表，所以 Web 客户端请使用 JSON 输入。

## 获得的凭据也有三个去处

客户端来源与凭据目标独立。例如，客户端从文件读，token 存入 1Password，完全可以。

### JSON：给喜欢结构化数据的程序

使用 `--store json --output PATH`。记录包含以下字段：

| 字段 | 含义 |
| --- | --- |
| `version`、`account` | 记录格式、已验证账号 |
| `client.clientId`、`client.clientSecret` | OAuth 客户端凭据 |
| `requestedScopes`、`grantedScopes` | 请求权限、实际授予权限 |
| `tokens.access_token`、`tokens.refresh_token` | 需要保密的 token |
| `tokens.expiry_date` | access token 到期时间，Unix 毫秒 |
| `obtainedAt`、`verifiedAt` | 获取 / 验证的 ISO 时间戳 |

检查成功与否不用打开这个文件，运行 `status` 就好。token 没有义务为了证明自己存在，专门召开一场记者会。

### 环境变量文件：给喜欢 export 的 shell

```sh
grantloom auth \
  --client-json "$HOME/.config/google/desktop-client.json" \
  --account you@example.com --scope gmail.readonly \
  --store env --output "$HOME/.config/grantloom/credentials/personal.env" \
  --prefix GRANTLOOM_PERSONAL --profile personal
```

文件保存带引号的 `export` 赋值。前缀之后的后缀为 `VERSION`、`ACCOUNT`、`CLIENT_ID`、`CLIENT_SECRET`、`REQUESTED_SCOPES`、`GRANTED_SCOPES`、`ACCESS_TOKEN`、`REFRESH_TOKEN`、`EXPIRY_DATE`、`OBTAINED_AT`、`VERIFIED_AT`。scope 列表是 JSON 字符串，`EXPIRY_DATE` 为 Unix 毫秒。默认前缀是 `GRANTLOOM`，不会自动按 profile 名称生成。

加载到当前 bash/zsh：

```sh
source "$HOME/.config/grantloom/credentials/personal.env"
```

只 source 可信文件。如有需要，可以自己把这**一行 source** 加进 shell 启动文件。Grantloom 不修改 `.zshrc`，也不能改变父 shell 的环境。刷新只更新文件，运行中的 shell 需要重新 source。只给一个脚本使用时，`exec` 可以避免将凭据加载到交互 shell。

### 1Password：让钥匙住进保险库

用现有的桌面集成 / `op signin` 认证 `op`，或通过 secret manager 提供服务账号 token。1Password 服务账号是可选的，与 Google 服务账号 JSON 密钥不是一回事。

```sh
grantloom auth \
  --client-json "$HOME/.config/google/desktop-client.json" \
  --account you@example.com --scope gmail.readonly \
  --store 1password --store-vault TOKEN_VAULT_ID \
  --title "Google OAuth personal" --profile personal
```

- `--title` 创建新条目，或找到兼容的 Grantloom 条目。同名匹配结果有多个时会报错。
- `--item TOKEN_ITEM_ID` 直接选择兼容的已有条目，不与 `--title` 同时使用。
- 没有 Grantloom 元数据的无关条目不会被覆盖。
- `--store-vault` 选择目标保险库；省略时可使用 `--op-vault` 的值。
- 确定后的稳定 item ID 会写入 profile。兼容条目中的无关字段会保留。
- 存储标签为 `version`、`account`、`client_id`、`client_secret`、`requested_scopes`、`granted_scopes`、`access_token`、`refresh_token`、`expiry_date`、`obtained_at`、`verified_at`。secret / token 字段类型为 `CONCEALED`。`--refresh-field FIELD` 可更改 refresh token 的字段标签。

设置了 `OP_SERVICE_ACCOUNT_TOKEN` 时，CLI 默认使用它。`--op-token-env MY_OP_TOKEN` 按**变量名**选择另一个变量。Grantloom 内部把秘密交给 `op`，但不会将其原始 stdout/stderr 转发到终端。

## scope：只领需要的钥匙

**scope 就是权限。** 只读权限像图书馆借阅证，完整权限更像整栋楼的钥匙。只是想看一本书，没必要顺便接任物业经理。

| 别名 | 权限 |
| --- | --- |
| `gmail.full` | Gmail 完整访问 |
| `gmail.readonly` | 读取 Gmail 邮件 |
| `gmail.modify` | 读取并修改 Gmail 邮件 |
| `gmail.compose` | 撰写并发送 Gmail 邮件 |
| `drive.full` | Drive 完整访问 |
| `drive.readonly` | 读取 Drive 文件 |
| `sheets` | 读取并编辑电子表格 |
| `sheets.readonly` | 读取电子表格 |
| `calendar` | 读取并编辑日历 |
| `calendar.readonly` | 读取日历 |

`--scope` 支持逗号分隔或多次指定，也可直接使用 `https://www.googleapis.com/auth/tasks.readonly`、`https://mail.google.com/` 等 Google scope URI。Grantloom 总会添加并显示 `openid`、`email`，用来核对账号身份。

```sh
grantloom scopes --json
grantloom scopes --api drive --json
grantloom scopes --project-id YOUR_PROJECT_ID --cloud-token-env CLOUD_READ_TOKEN --json
grantloom scopes --project-id YOUR_PROJECT_ID \
  --cloud-token-file "$HOME/.config/google/cloud-read-token" --json
grantloom scopes --project-id YOUR_PROJECT_ID \
  --cloud-token-op op://CLOUD_VAULT_ID/CLOUD_ITEM_ID/access_token --json
```

**API 已启用 ≠ 账号已同意授权。** 这是两件事。门禁通电了，不代表你的门卡已经办好了。

查询已启用 API 需要项目 ID，以及具有 Service Usage 读取权限的**另一份 Cloud 只读查询凭据**。token 文件只放 Cloud access token，环境变量参数传变量名。Cloud 来源一次选一个。`op://VAULT/ITEM/FIELD` 各部分内部的空格或斜杠需要 percent-encode。

**Cloud token 文件也需要私有权限。** macOS/Linux 请把文件放在当前用户拥有、权限为 `0700` 的目录中，文件权限设为 `0600`。不安全的权限、symlink 或其他用户可写的父目录，可能让查询尚未请求 Google 就返回 `unavailable`。先在示例路径私下准备好 token 文件，再设置：

```sh
chmod 700 "$HOME/.config/google"
chmod 600 "$HOME/.config/google/cloud-read-token"
```

Windows 请用 `--cloud-token-env` 或 `--cloud-token-op` 作为 Cloud 输入来源，不支持从 Cloud token 文件读取。

没有 Cloud 凭据时状态为 `unverified`；查询失败为 `unavailable`，手动选择 scope 仍可继续。这些参数也适用于 `auth`，项目可从客户端 JSON 获取，`--project-id` 可覆盖。Grantloom 不会自行启用 API，也不会把 Cloud scope 塞进用户授权请求。

`--api` 使用 Google Discovery。预设版本为 Drive v3、Sheets v4、Calendar v3，其他 ID 默认为 v1。需要其他版本的 API 可能无法发现，直接提供 scope URI 即可。

## 全部 CLI 命令

| 命令 | 做什么 | 示例 |
| --- | --- | --- |
| `auth` | 浏览器同意 → 验证 → 凭据保存 → profile 保存 | `grantloom auth` |
| `scopes` | 列出 scope 候选及可选的 API 启用状态 | `grantloom scopes --json` |
| `status` | 读取已保存元数据，不向 Google 发起刷新 | `grantloom status --profile personal --json` |
| `refresh` | 刷新、验证，并更新原存储位置 | `grantloom refresh --profile personal --json` |
| `exec` | 将凭据注入一个子进程 | `grantloom exec --profile personal -- node ./your-google-api-script.mjs` |
| `mcp` | 启动 stdio MCP 服务，由宿主保持运行 | `grantloom mcp` |

默认命令是 `auth`。也支持 `--help` 和 `--version`。

### exec 会交给脚本什么？

| 环境变量 | 内容 |
| --- | --- |
| `GRANTLOOM_CLIENT_ID` | client ID |
| `GRANTLOOM_CLIENT_SECRET` | client secret |
| `GRANTLOOM_ACCESS_TOKEN` | 当前 access token |
| `GRANTLOOM_REFRESH_TOKEN` | refresh token |
| `GRANTLOOM_ACCESS_TOKEN_EXPIRES_AT` | ISO 格式到期时间 |

Node.js 脚本可读取 `process.env.GRANTLOOM_ACCESS_TOKEN`，交给对应的 Google API 客户端。profile 若设置 `--prefix GRANTLOOM_PERSONAL`，上述变量名中的 `GRANTLOOM` 会换成 `GRANTLOOM_PERSONAL`。

参数不经 shell 转交，退出码取自子进程。不自动刷新过期 token，请先运行 `refresh`。注入内容包括 access 和 refresh 凭据，因此只运行可信程序。子进程输出原样转发：一个打印全部环境变量的脚本，依然能把钥匙晒出来。前台负责发钥匙，管不了你旁边那台复印机。

### 输出与退出码

结果包含 `status`、`account`、`profile`、`requestedScopes`、`grantedScopes`、`expiresAt`、`storage` 等元数据。当前 CLI 即使没有 `--json` 也输出 JSON 结果，该参数可用于明确意图。help/version 为文本，`exec` 转发子进程输出。

`auth` 的提示、scope 候选、选择结果、授权 URL 写到 **stderr**，最终状态写到 **stdout**。错误返回固定、安全的 `code` / `message`。普通结果不包含 token 或 client secret。

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 运行失败 |
| `2` | 配置无效 |
| `130` | 取消 |
| 子进程退出码 | 由 `exec` 返回 |

## CLI 参数速查

| 分类 | 参数 |
| --- | --- |
| 客户端来源 | `--client-json PATH` **或** `--client-env VAR` **或** `--client-op-item ID` |
| 1Password 客户端 | `--op-vault VAULT`、`--client-id-field FIELD`、`--client-secret-field FIELD`、`--client-project-field FIELD`、`--client-type installed\|web` |
| 1Password 认证 | `--op-token-env VAR` |
| 身份与权限 | `--account EMAIL`、可重复的 `--scope ALIAS_OR_URI` |
| 存储目标 | `--store json\|env\|1password`、`--output PATH`、`--prefix PREFIX` |
| 1Password 存储目标 | `--store-vault VAULT`、`--item ID` **或** `--title NAME`、`--refresh-field FIELD` |
| profile 与浏览器 | `--profile NAME`、`--redirect-uri URI`、`--no-open` |
| 可选 Cloud / API 查询 | `--project-id ID`、`--cloud-token-env VAR` **或** `--cloud-token-file PATH` **或** `--cloud-token-op REF`、`--api API` |
| 输出 / 帮助 | `--json`、`--help`、`--version` |

客户端、存储、账号、浏览器和 Cloud 查询参数用于 `auth`。Cloud 查询参数也可用于 `scopes`；`status`、`refresh`、`exec` 使用已保存的 `--profile`。传入不属于该命令的参数会报错。没有直接接收秘密值的命令行参数，请传文件、变量名或 1Password 引用。

## MCP：给 AI 助手的七件工具

兼容 MCP 的 AI 宿主可以调用 Grantloom。在宿主配置中添加 stdio 服务，具体配置文件位置由宿主决定：

```json
{
  "mcpServers": {
    "grantloom": {
      "command": "npx",
      "args": ["--yes", "grantloom@0.1.0", "mcp"]
    }
  }
}
```

客户端和存储引用所需的环境变量，应通过宿主的秘密管理机制提供。不要将真实秘密写进共享配置。宿主负责启动并保持进程，stdout 专用于 MCP JSON-RPC。

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `auth_start` | `{"profile": {…}}` | 开始授权，立即返回 session 的 `id`、Google `url` 和公开状态 |
| `auth_status` | `{"id":"SESSION_ID"}` | 查询内存中的授权 session |
| `auth_save_retry` | `{"id":"SESSION_ID"}` | 重试已验证 session 的失败保存，不重复授权 |
| `auth_cancel` | `{"id":"SESSION_ID"}` | 取消；已经开始保存则等待其完成 |
| `scopes_list` | `{}` 或下述查询参数 | 列出 scope 和可选的 API 启用状态 |
| `refresh` | `{"profile":"personal"}` | 刷新已保存 profile，返回元数据 |
| `profile_status` | `{"profile":"personal"}` | 不远程刷新，只读取已保存元数据 |

从文件读取客户端、保存到 1Password 的 `auth_start` 参数示例：

```json
{
  "profile": {
    "version": 1,
    "name": "personal",
    "account": "you@example.com",
    "clientSource": {"file": "/absolute/path/to/desktop-client.json"},
    "scopes": ["gmail.readonly"],
    "store": {
      "kind": "1password",
      "vault": "TOKEN_VAULT_ID",
      "title": "Google OAuth personal"
    }
  }
}
```

客户端还可使用 `{"env":"GOOGLE_OAUTH_CLIENT_JSON"}` 或 `{"op":{"vault":"CLIENT_VAULT_ID","item":"OAUTH_CLIENT_ITEM_ID"}}`。文件存储用 `{"kind":"json","path":"/absolute/private/path/personal.json"}`，或 `kind: "env"` 加可选的 `prefix`。

`scopes_list` 接受可选的 `projectId`、`api`，以及 `cloudTokenEnv`、`cloudTokenFile`、`cloudTokenOp` 三选一。最后一个是包含 `vault`、`item`、可选 `field` / `tokenEnv` 的对象。客户端 op 引用支持 `tokenEnv`、`clientIdField`、`clientSecretField`、`projectIdField`、`type`；存储 op 引用支持 `item` 或 `title`、`tokenEnv`、`refreshField`。提供变量名，不提供秘密值。未知 schema 字段会被拒绝。

流程为**开始 → 人打开 URL 并同意 → 轮询 → saved**。每个服务只允许一个活动 session，`save-failed` 也算其中一个。session 仅存于内存，30 分钟后过期。断开连接会取消 session 并关闭回调监听器，已保存的 profile 和凭据仍保留。没有返回 token 或执行任意子命令的工具。

## 随附的 agent Skill

[Skill](skills/grantloom/SKILL.md) 是给 AI 助手的操作说明：询问安全的引用位置，使用 CLI，把浏览器登录、多因素认证和授权交给人。它不是另一个常驻服务。机器人可以拿登记板，但不用借走你的指纹。

如果 agent 读取 `$HOME/.codex/skills`，可以这样安装随附文件：

```sh
npm install -g grantloom@0.1.0
mkdir -p "$HOME/.codex/skills/grantloom"
cp "$(npm root -g)/grantloom/skills/grantloom/SKILL.md" \
  "$HOME/.codex/skills/grantloom/SKILL.md"
```

按需重新加载 Skill。其他 agent 的目录可能不同。Skill 禁止将凭据文件或 1Password 的秘密字段读入聊天、展示秘密值，或用环境变量转储来“验证”认证。主要入口是 CLI，MCP 为可选方案。

## 授权时，后台做了什么？

1. 在请求同意前检查客户端 / profile 配置及存储目标。
2. 在 `127.0.0.1` 启动临时 HTTP 回调监听器。
3. 带 PKCE S256、随机 state、OIDC nonce 发起 Google 授权。
4. 检查只能使用一次的回调，用 Google 官方库验证 ID token，核对已验证邮箱与请求账号。
5. 检查实际 scope，并要求存在 refresh token。
6. 完成一次刷新往返，再验证新的 access token。
7. 保存凭据，读回比较，然后保存 profile。
8. 返回带元数据的 `saved`。token 留在后台，不安排谢幕，更不安排合影。

Google 登录和 API 请求仍使用 Google 服务，1Password 存储使用你配置的保险库权限。“没有托管认证服务”指 Grantloom 不会额外插入自己的远程认证后端。

## 遇到问题怎么办？

| 现象 | 检查 / 处理 |
| --- | --- |
| `INVALID_CONFIG` / `INVALID_CLIENT` | 参数、非交互必填项、JSON 类型、原始客户端来源 |
| `STORE_NOT_FOUND` | profile 名、`GRANTLOOM_CONFIG_DIR`、目标位置、1Password 权限 |
| `STORE_UNSAFE` | 使用父目录权限也安全的私有路径，避免 symlink 目标 |
| `STORE_CONFLICT` | 不同账号、客户端、scope 使用不同目标 / profile |
| `STORE_AMBIGUOUS` | 处理 1Password 同名条目，或指定兼容条目的 ID |
| `ACCOUNT_MISMATCH` | 用请求的 Google 账号重新同意 |
| `SCOPES_MISSING` | 同意全部 scope，并检查应用 / 管理员限制 |
| `REFRESH_MISSING` | 重新同意，并检查 Google 的 refresh token 发放规则 |
| `TOKEN_EXPIRED` | 运行 `grantloom refresh --profile personal --json` 后重试脚本 |
| `OAUTH_DENIED` / `OAUTH_FAILED` | 同意界面、测试用户、Workspace 政策 |
| `FILE_STORE_UNSUPPORTED` | Windows 请用 1Password |
| 浏览器打不开 | 手动打开授权 URL，保持 CLI 运行 |

**保存失败？** 交互 CLI 会在内存中保留已验证凭据，提供 `retry` / `cancel`。MCP 可用同一 session ID 调用 `auth_save_retry`。修复目标权限等问题后，在同一 session 内重试即可。非交互 CLI 报告失败，并在退出时清理保留的 session。

**取消会怎样？** Ctrl-C 取消等待同意 / 验证中的操作。一旦开始持久化，会等写入、读回、profile 保存结束。已成功保存的结果仍是 `saved`，失败的保存则报告取消。不提供回滚或 token 撤销；保存失败后可能留下部分凭据。

**过几天不能用了？** refresh token 也会过期或被撤销。External 应用处于 Testing 时通常为七天，仅身份确认 scope 等情况有例外。涉及 Gmail scope 的密码变更、管理员政策、发放数量限制也可能影响它。参见 [Google 官方到期规则](https://developers.google.com/identity/protocols/oauth2#expiration)。refresh 是可以续，不是终身会员卡。

**留下了锁文件？** 写入进程被强制结束可能遗留 `.grantloom.lock`。确认没有活跃 writer 后再删除。文件采用原子替换，但不承诺 directory fsync 级别的崩溃耐久性；1Password 更新也不承诺远程 compare-and-swap。

## 开发与许可证

```sh
npm ci
npm test
npm run check
npm pack --dry-run
```

实现使用 Google 官方认证库、官方 MCP SDK，以及 Node 内置的 HTTP、文件、子进程和测试工具。CI 覆盖 Linux/macOS 的 Node 22/24，并在 Windows Node 24 重点检查 profile / help。测试使用合成凭据和可控的远程边界。

文档：[English](README.md) · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)。采用 [MIT 许可证](LICENSE)。
