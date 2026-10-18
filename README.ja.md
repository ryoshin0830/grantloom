# Grantloom

**Google OAuth。認証したかっただけなのに、OAuthに就職しかけたあなたへ。**

[English](https://github.com/ryoshin0830/grantloom/blob/main/README.md) · **日本語** · [简体中文](https://github.com/ryoshin0830/grantloom/blob/main/README.zh-CN.md)

「カレンダーを読むスクリプトを書きたい」。たったそれだけの願いだった。気づけばブラウザには6つのタブ、手元には3種類の認証情報。そして、触ったら壊れそうなリフレッシュトークン。

Grantloomは、その認証手続きを引き受けるツールです。**自分のGoogle OAuthクライアントを用意し、ブラウザで同意すると、検証済みの認証情報を1Password・非公開のJSON・環境変数ファイルへ保存**します。スクリプトには子プロセスの環境変数で渡せます。AIエージェントもCLI・MCP・同梱Skillから認証をお手伝いできます。

Googleとは無関係の独立プロジェクトです。Grantloom独自の認証サーバーや会員登録はありません。名前に「Grant」とありますが、研究助成金も出ません。出るのは必要な権限です。

## 目次

- [何ができるの？](#何ができるの)
- [最初の認証まで](#最初の認証まで)
- [ファイルはどこに何ができる？](#ファイルはどこに何ができる)
- [OAuthクライアントの入力元は3種類](#oauthクライアントの入力元は3種類)
- [取得した認証情報の保存先も3種類](#取得した認証情報の保存先も3種類)
- [scope：必要な鍵だけ持ちましょう](#scope必要な鍵だけ持ちましょう)
- [CLIコマンド全一覧](#cliコマンド全一覧)
- [CLIオプション早見表](#cliオプション早見表)
- [MCP：エージェント向けの7つ道具](#mcpエージェント向けの7つ道具)
- [同梱のエージェントSkill](#同梱のエージェントskill)
- [認証の裏側で何をしている？](#認証の裏側で何をしている)
- [困ったときは](#困ったときは)
- [開発とライセンス](#開発とライセンス)

## 何ができるの？

| やりたいこと | Grantloomがすること |
| --- | --- |
| Gmail・Drive・Sheets・Calendarなどを使うスクリプトに権限を渡す | 選んだscopeでブラウザ同意を行い、実際のアカウントと付与された権限を検証 |
| トークンをチャットやターミナルに貼らずに扱う | 表示はメタデータだけ。認証情報は指定の保存先へ直接保存 |
| 仕事用と個人用を分ける | クライアント参照・アカウント・scope・保存先を、名前付きprofileで管理 |
| アクセストークンを更新する | 保存済みprofileを使って更新し、検証後に同じ保存先を書き換える |
| 自分のスクリプトで認証情報を使う | `exec`で子プロセスの環境変数へ注入 |
| AIエージェントに認証手続きを手伝わせる | CLI・MCP全7ツール・Skillを提供 |
| 選べる権限を調べる | 一般的なscope候補、任意のAPI Discovery、有効APIの確認に対応 |

担当は**認証・権限・認証情報の受け渡し**です。Grantloom自体がメールを読んだり、送信したり、スプレッドシートを編集したりするわけではありません。その仕事は認証情報を使うプログラムが担当します。ホテルの鍵を渡す係であって、清掃から朝食まで全部やる係ではありません。

Google APIの有効化、Workspaceポリシーの回避、バックグラウンドでの自動更新、ローカルファイル削除時のトークン失効は行いません。トークン表示コマンドや、任意のコマンドを実行するMCPツールもありません。

### 用語を6つだけ。テストには出ません。

| 用語 | ざっくり言うと |
| --- | --- |
| OAuthクライアント | Googleへ「どのアプリか」を伝えるもの。自分のGoogleアカウントとは別 |
| アカウント | アクセスを許可するGoogleの利用者 |
| scope | その利用者にお願いする権限 |
| access token | API呼び出しに使う、有効期限付きの認証情報 |
| refresh token | 有効な間は、ブラウザ同意を繰り返さず新しいaccess tokenを取得するための認証情報 |
| profile | アカウント・クライアント・scope・保存先の組み合わせに付ける名前と、保存した参照情報 |

## 最初の認証まで

### 1. 材料をそろえる

- **Node.js 22以上**とnpm。
- Googleアカウントと、設定できるGoogle Cloudプロジェクト。
- Google OAuthクライアント。まずは**デスクトップアプリ**型が簡単です。
- Googleログイン・多要素認証・同意に使うブラウザ。
- 任意：[1Password CLI](https://developer.1password.com/docs/cli/get-started/)。Vaultへ保存するときに使います。

| OS | JSON・環境変数ファイルへの認証情報保存 | 1Password |
| --- | --- | --- |
| macOS / Linux | 対応 | `op`があれば対応 |
| Windows | 非対応として明示的にエラー | `op`があれば対応 |

コマンド例はbash/zshの書式です。Windowsでは1Passwordを使い、複数行コマンドを利用中のシェルに合わせてください。Windowsでもprofileのメタデータはローカル保存され、保護はOSのユーザーディレクトリ権限に依存します。

### 2. Google OAuthクライアントを作る

自分のGoogle Cloudプロジェクトで、次を設定します。

1. プログラムで使うAPIを有効にする。
2. OAuth同意画面・対象ユーザーを設定する。Testingの場合は自分のアカウントをテストユーザーへ追加する。
3. アプリケーションの種類を**デスクトップアプリ**にしてOAuthクライアントを作る。
4. JSONをダウンロードして、たとえば `$HOME/.config/google/desktop-client.json` へ非公開で配置する。

JSONには `installed` オブジェクトがあり、`client_id`・`client_secret`・任意の `project_id` などが入っています。サービスアカウント鍵は別の認証方式なので、ここでは使えません。作成手順は[Google公式のデスクトップOAuthガイド](https://developers.google.com/identity/protocols/oauth2/native-app)も参照してください。

ファイルはリポジトリの外へ。macOS/Linuxでは、ダウンロードしたファイルを例のパスへ置いたうえで、次の権限にしてください。Grantloomは入力を読み込みますが、元のファイルの権限までは直しません。

```sh
mkdir -p "$HOME/.config/google"
chmod 700 "$HOME/.config/google"
chmod 600 "$HOME/.config/google/desktop-client.json"
```

### 3. インストールする。npxで借りるのもOK

```sh
npm install -g grantloom@0.1.0
grantloom --help
```

グローバルインストールをしないなら `npx --yes grantloom@0.1.0 auth` で実行できます。以降の例も `grantloom` の代わりに `npx --yes grantloom@0.1.0` を使えます。

### 4. こちらがお願いし、Googleが正式に確認する

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

`you@example.com` は自分のアカウントへ変更してください。このガイドのパスやitem IDはすべて例で、個人の設定は同梱されていません。

Grantloomがアカウント・要求するscope全体・保存先を表示し、Googleの同意画面を開きます。指定したアカウントを選び、必要な権限へ同意してください。`saved` が出るまでCLIは起動したままにします。

ターミナルで `grantloom auth` だけを実行すると、クライアントの入力元、アカウント、scope、保存形式、保存先、profile名を順に質問します。scopeを空欄にすると本人確認だけを要求します。対話できない環境では必須項目を引数で指定し、不足時は `INVALID_CONFIG`・終了コード `2` になります。

ブラウザが開かなければ表示されたGoogle同意URLを自分で開いてください。`--no-open` は自動起動だけを止めます。同意そのものは省略できません。コールバックはCLIを動かしているマシンのローカルで受けるため、SSH・コンテナではブラウザからそのマシンのloopbackへ届く構成が必要です。

### 5. 確認して、更新して、使う

```sh
grantloom status --profile personal --json
grantloom refresh --profile personal --json
grantloom exec --profile personal -- node ./your-google-api-script.mjs
```

最後のコマンドのスクリプトは自分で用意します。Grantloomが生成するファイルではありません。受け取れる環境変数は[CLIコマンド全一覧](#cliコマンド全一覧)で説明します。

## ファイルはどこに何ができる？

登場人物は**3種類**です。全員に `credentials.json` と名付けると、午後が推理ドラマになります。

| 種類 | 誰が作る？ | 配置例 | 中身 |
| --- | --- | --- | --- |
| **OAuthクライアント入力** | 自分・Google Cloud | `~/.config/google/desktop-client.json` | アプリのclient ID、client secret、プロジェクト情報 |
| **profile** | 保存成功後にGrantloom | `~/.config/grantloom/personal.json` | アカウント、scope、クライアント入力元・保存先の参照。トークンやclient secretの値は含まない |
| **認証情報レコード** | Grantloom | `--output` で指定した場所、または1Passwordの項目 | client ID/secret、access/refresh token、有効期限、アカウント、scope、検証日時 |

最初のJSON保存の例だと、こうなります。

```text
~/.config/
├── google/
│   └── desktop-client.json        ← 自分で用意する入力。非公開にする
└── grantloom/
    ├── personal.json              ← profile。参照先とメタデータ
    └── credentials/
        └── personal.json          ← 実際の認証情報。非公開にする
```

`--store env` なら `credentials/personal.env` のようなパスを選びます。`--store 1password` なら認証情報はVault内にあり、profileは引き続きローカルに作られます。元のクライアントは自分で配置した場所に残ります。

**認証情報の保存先は自分で指定します。** 引数で指定するか、対話で答えます。上の例のパスへ勝手に保存されるわけではありません。

**profileの既定値：** `$HOME/.config/grantloom/<profile>.json`。`GRANTLOOM_CONFIG_DIR` でprofileのディレクトリを変更できます。元のクライアントを移動したり、`--output` で選んだ保存先を変えたりはしません。以降の実行でも同じ設定を使ってください。profile名は小文字英字・数字・ハイフンの1〜63文字で、先頭は英字か数字です。

**元のクライアントは消さないでください。** `status`・`refresh`・`exec` も入力元を読み直します。ファイルなら読み取れる状態、環境変数なら各プロセスで設定済み、1Passwordなら `op` でアクセスできる状態が必要です。

**ローカルファイルは平文で、暗号化されません。** macOS/Linuxではprofile・認証情報ファイルに非公開権限（ディレクトリ `0700`、ファイル `0600`）、atomic置換、symlink・危険なパスの検査を使います。同じOSユーザーの別プロセスは読み取れる場合があります。Vault保存が必要なら1Passwordを選んでください。profileにもメールアドレスやパスなどの個人メタデータがあるため、公開しないでください。

アカウントや権限セットを分けるなら、profile名と認証情報の保存先も分けます。保存先に別アカウント・別クライアント・別scopeのレコードがある場合は拒否します。

## OAuthクライアントの入力元は3種類

認証ごとに**1つ**選びます。引数に渡すのは秘密値そのものではなく、秘密値の置き場所です。

| 入力元 | オプション | 必要なもの |
| --- | --- | --- |
| GoogleのクライアントJSON | `--client-json PATH` | `installed` または `web` を持つ読み取り可能なJSON |
| 環境変数 | `--client-env VARIABLE_NAME` | クライアントJSON全体を入れた変数 |
| 1Password項目 | `--client-op-item ITEM_ID --op-vault VAULT_ID` | 必須のクライアントfieldを持つ、アクセス可能な項目 |

環境変数を使う場合は、JSONを表示せずローカルで読み込み、**変数名**を渡します。

```sh
export GOOGLE_OAUTH_CLIENT_JSON="$(< "$HOME/.config/google/desktop-client.json")"
grantloom auth \
  --client-env GOOGLE_OAUTH_CLIENT_JSON \
  --account you@example.com --scope drive.readonly \
  --store json --output "$HOME/.config/grantloom/credentials/drive.json" \
  --profile drive
```

1Passwordの既定のfieldラベルは `client_id`・`client_secret`・任意の `project_id`、クライアント型は `installed` です。既存のfield名が違うなら対応付けできます。

```sh
grantloom auth \
  --client-op-item OAUTH_CLIENT_ITEM_ID --op-vault CLIENT_VAULT_ID \
  --client-id-field username --client-secret-field credential \
  --client-project-field project_id --client-type installed \
  --account you@example.com --scope gmail.readonly \
  --store 1password --store-vault TOKEN_VAULT_ID \
  --title "Google OAuth personal" --profile personal
```

### Webクライアントをすでに持っている場合

JSONファイルか環境変数を使い、固定portとcallback pathを明示した**HTTP・IPv4 loopback**のURIを登録してください。`--redirect-uri` は `web.redirect_uris` の登録値との完全一致が必要です。登録portが使用中でも別のportへ変更しません。

```sh
grantloom auth \
  --client-json "$HOME/.config/google/web-client.json" \
  --redirect-uri http://127.0.0.1:8765/oauth/callback \
  --account you@example.com --scope sheets.readonly \
  --store json --output "$HOME/.config/grantloom/credentials/sheets.json" \
  --profile sheets
```

Desktop型は空いている `127.0.0.1` のportを使い、`--redirect-uri` は指定できません。Web型は `127.0.0.1` または `localhost` に対応します。この実装ではIPv6・外部HTTPS callbackには対応しません。1Password入力には登録redirect一覧がないため、Web型はJSON入力を使ってください。

## 取得した認証情報の保存先も3種類

クライアントの入力元と、取得した認証情報の保存先は独立しています。「クライアントはファイル、トークンは1Password」でもOKです。

### JSON：構造化データが好きなプログラムへ

`--store json --output PATH` を使います。レコードの中身は次の通りです。

| field | 意味 |
| --- | --- |
| `version`・`account` | レコード形式と検証済みアカウント |
| `client.clientId`・`client.clientSecret` | OAuthクライアントの認証情報 |
| `requestedScopes`・`grantedScopes` | 要求した権限・実際に付与された権限 |
| `tokens.access_token`・`tokens.refresh_token` | 秘密に保つトークン |
| `tokens.expiry_date` | アクセストークンの有効期限。Unix時刻・ミリ秒 |
| `obtainedAt`・`verifiedAt` | 取得・検証のISO日時 |

成功確認のために開く必要はありません。そのための `status` です。トークンを記者会見に出席させなくて大丈夫です。

### 環境変数ファイル：exportが好きなシェルへ

```sh
grantloom auth \
  --client-json "$HOME/.config/google/desktop-client.json" \
  --account you@example.com --scope gmail.readonly \
  --store env --output "$HOME/.config/grantloom/credentials/personal.env" \
  --prefix GRANTLOOM_PERSONAL --profile personal
```

引用符付きの `export` 文を保存します。上のprefixに続くsuffixは `VERSION`・`ACCOUNT`・`CLIENT_ID`・`CLIENT_SECRET`・`REQUESTED_SCOPES`・`GRANTED_SCOPES`・`ACCESS_TOKEN`・`REFRESH_TOKEN`・`EXPIRY_DATE`・`OBTAINED_AT`・`VERIFIED_AT` です。scope一覧はJSON文字列、`EXPIRY_DATE` はUnix時刻・ミリ秒です。prefixの既定値は `GRANTLOOM` で、profile名から自動生成はされません。

現在のbash/zshへ読み込むには：

```sh
source "$HOME/.config/grantloom/credentials/personal.env"
```

信頼できるファイルだけをsourceしてください。必要なら、この**sourceの1行**を自分でシェルの起動設定へ追加します。Grantloomは `.zshrc` を編集せず、親シェルの環境変数も変更しません。更新するのはファイルなので、起動済みシェルには再度sourceが必要です。単一スクリプトへ渡すなら `exec` を使うと、対話シェルに認証情報を読み込まずに済みます。

### 1Password：鍵には鍵らしい住まいを

既存のDesktop連携・`op signin` で `op` を認証するか、secret manager経由でサービスアカウントトークンを用意します。1Passwordのサービスアカウントは任意です。GoogleのサービスアカウントJSON鍵とは別物です。

```sh
grantloom auth \
  --client-json "$HOME/.config/google/desktop-client.json" \
  --account you@example.com --scope gmail.readonly \
  --store 1password --store-vault TOKEN_VAULT_ID \
  --title "Google OAuth personal" --profile personal
```

- `--title` は項目を新規作成するか、互換性のあるGrantloom項目を見つけます。同名候補が複数ある場合はエラーです。
- `--item TOKEN_ITEM_ID` は互換性のある既存項目を選びます。`--title` とは併用しません。
- Grantloomのメタデータがない無関係の項目は上書きしません。
- 保存先Vaultは `--store-vault` で選びます。省略時は `--op-vault` の値を利用できます。
- 確定したitem IDをprofileへ保存します。既存の互換項目にある無関係のfieldは残します。
- 保存ラベルは `version`・`account`・`client_id`・`client_secret`・`requested_scopes`・`granted_scopes`・`access_token`・`refresh_token`・`expiry_date`・`obtained_at`・`verified_at`。secret・tokenのfieldは `CONCEALED` です。`--refresh-field FIELD` でrefresh tokenのラベルを変更できます。

`OP_SERVICE_ACCOUNT_TOKEN` があればCLIが既定で利用します。`--op-token-env MY_OP_TOKEN` は別の変数を**名前で**選びます。Grantloomは内部で秘密値を `op` へ渡しますが、その生のstdout/stderrをターミナルへ転送しません。

## scope：必要な鍵だけ持ちましょう

**scopeは権限**です。読み取り専用が図書館の利用証なら、フルアクセスは建物の合鍵に近いもの。ちょっと本を読むために管理人に就任する必要はありません。

| 別名 | 権限 |
| --- | --- |
| `gmail.full` | Gmailのフルアクセス |
| `gmail.readonly` | Gmailのメッセージを読む |
| `gmail.modify` | Gmailのメッセージを読み、変更する |
| `gmail.compose` | Gmailのメールを作成・送信する |
| `drive.full` | Driveのフルアクセス |
| `drive.readonly` | Driveのファイルを読む |
| `sheets` | スプレッドシートを読み書きする |
| `sheets.readonly` | スプレッドシートを読む |
| `calendar` | カレンダーを読み書きする |
| `calendar.readonly` | カレンダーを読む |

`--scope` はカンマ区切りでも、複数回指定でも使えます。`https://www.googleapis.com/auth/tasks.readonly`・`https://mail.google.com/` のようなGoogle scope URIの直接指定にも対応します。本人照合のため `openid`・`email` を必ず追加し、事前に表示します。

```sh
grantloom scopes --json
grantloom scopes --api drive --json
grantloom scopes --project-id YOUR_PROJECT_ID --cloud-token-env CLOUD_READ_TOKEN --json
grantloom scopes --project-id YOUR_PROJECT_ID \
  --cloud-token-file "$HOME/.config/google/cloud-read-token" --json
grantloom scopes --project-id YOUR_PROJECT_ID \
  --cloud-token-op op://CLOUD_VAULT_ID/CLOUD_ITEM_ID/access_token --json
```

**APIが有効 ≠ アカウントが権限に同意済み。** この2つは別の条件です。自動ドアに電源が入っていても、入館証が発行されたことにはなりません。

有効APIの確認には、project IDとService Usageの読み取り権限を持つ**別のCloud閲覧用認証情報**が必要です。トークンファイルの内容はCloud access tokenのみ、環境変数オプションは変数名を指定します。Cloud入力元は同時に1つです。`op://VAULT/ITEM/FIELD` の各要素内に空白やスラッシュがある場合はpercent-encodeしてください。

**Cloudトークンファイルにも非公開権限が必要です。** macOS/Linuxでは、自分が所有する権限 `0700` のディレクトリへ置き、ファイルは `0600` にします。危険な権限・symlink・他者が書き込める親ディレクトリがあると、Googleへ問い合わせる前に `unavailable` になる場合があります。例のパスへトークンファイルを非公開で用意した後、次を設定してください。

```sh
chmod 700 "$HOME/.config/google"
chmod 600 "$HOME/.config/google/cloud-read-token"
```

WindowsのCloud入力には `--cloud-token-env` または `--cloud-token-op` を使ってください。Cloudトークンファイルからの読み込みは非対応です。

Cloud認証情報なしでは `unverified`、一覧取得失敗では `unavailable` となり、手動のscope選択は引き続き使えます。これらのオプションは `auth` にも使えます。projectはクライアントJSONから取得でき、`--project-id` で上書きできます。Google APIの有効化や、ユーザー同意へのCloud scope追加は行いません。

`--api` はGoogle Discoveryを使います。既定のversionはDrive v3・Sheets v4・Calendar v3、それ以外のIDはv1です。別versionが必要なAPIは発見できない場合があるため、scope URIを直接指定してください。

## CLIコマンド全一覧

| コマンド | 動作 | 例 |
| --- | --- | --- |
| `auth` | ブラウザ同意 → 検証 → 認証情報保存 → profile保存 | `grantloom auth` |
| `scopes` | scope候補と任意のAPI有効状態を一覧表示 | `grantloom scopes --json` |
| `status` | 保存済みメタデータを読む。Googleへ更新要求はしない | `grantloom status --profile personal --json` |
| `refresh` | トークンを更新・検証し、同じ保存先へ保存 | `grantloom refresh --profile personal --json` |
| `exec` | 認証情報を1つの子プロセスへ注入 | `grantloom exec --profile personal -- node ./your-google-api-script.mjs` |
| `mcp` | stdio MCPサーバーを起動。ホストが起動状態を保つ | `grantloom mcp` |

コマンド省略時は `auth` です。`--help`・`--version` も使えます。

### execでスクリプトに渡るもの

| 環境変数 | 値 |
| --- | --- |
| `GRANTLOOM_CLIENT_ID` | client ID |
| `GRANTLOOM_CLIENT_SECRET` | client secret |
| `GRANTLOOM_ACCESS_TOKEN` | 現在のaccess token |
| `GRANTLOOM_REFRESH_TOKEN` | refresh token |
| `GRANTLOOM_ACCESS_TOKEN_EXPIRES_AT` | 有効期限のISO日時 |

Node.jsなら `process.env.GRANTLOOM_ACCESS_TOKEN` などを読み、対応するGoogle API clientへ渡します。`--prefix GRANTLOOM_PERSONAL` を設定したprofileでは、変数名の `GRANTLOOM` が `GRANTLOOM_PERSONAL` に変わります。

引数はshellを介さず渡し、子プロセスの終了コードを返します。期限切れトークンは自動更新しないので、先に `refresh` してください。access tokenだけでなくrefresh tokenなども注入されるため、信頼するプログラムを実行してください。子の出力はそのまま転送します。環境変数を丸ごと表示するプログラムを動かせば、鍵も丸見えです。鍵の受付係は、あなたのコピー機までは止められません。

### 出力と終了コード

結果は `status`・`account`・`profile`・`requestedScopes`・`grantedScopes`・`expiresAt`・`storage` などのメタデータです。現行CLIは `--json` なしでもJSON結果を出力し、同フラグは意図を明示するために指定できます。help/versionはテキスト、`exec` は子プロセスの出力です。

`auth` の質問・scope候補・選択内容・同意URLは**stderr**、最終結果は**stdout**です。エラーは安全な固定の `code`・`message` を返します。通常の結果にトークンやclient secretは含みません。

| 終了コード | 意味 |
| --- | --- |
| `0` | 成功 |
| `1` | 実行時の失敗 |
| `2` | 設定の不備 |
| `130` | キャンセル |
| 子プロセスの終了コード | `exec` がそのまま返す |

## CLIオプション早見表

| 分類 | オプション |
| --- | --- |
| クライアント入力元 | `--client-json PATH` **または** `--client-env VAR` **または** `--client-op-item ID` |
| 1Passwordクライアント | `--op-vault VAULT`・`--client-id-field FIELD`・`--client-secret-field FIELD`・`--client-project-field FIELD`・`--client-type installed\|web` |
| 1Password認証 | `--op-token-env VAR` |
| 本人と権限 | `--account EMAIL`・繰り返し指定可能な `--scope ALIAS_OR_URI` |
| 保存先 | `--store json\|env\|1password`・`--output PATH`・`--prefix PREFIX` |
| 1Password保存先 | `--store-vault VAULT`・`--item ID` **または** `--title NAME`・`--refresh-field FIELD` |
| profileとブラウザ | `--profile NAME`・`--redirect-uri URI`・`--no-open` |
| 任意のCloud・API確認 | `--project-id ID`・`--cloud-token-env VAR` **または** `--cloud-token-file PATH` **または** `--cloud-token-op REF`・`--api API` |
| 出力・ヘルプ | `--json`・`--help`・`--version` |

入力元・保存先・アカウント・ブラウザ・Cloud確認のオプションは `auth` 用です。Cloud確認のオプションは `scopes` にも使えます。`status`・`refresh`・`exec` は保存済みの `--profile` を使います。対象外のオプションはエラーになります。秘密値そのものを引数にするオプションはありません。ファイル・変数名・1Password参照を渡します。

## MCP：エージェント向けの7つ道具

MCP対応のAIホストからGrantloomの操作を呼び出せます。ホストの設定へstdioサーバーを追加してください。設定ファイルの場所はホストによって異なります。

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

入力元や保存先で必要な環境変数は、ホストのsecret管理機能を通して渡します。共有設定へ秘密値を直書きしないでください。プロセスの起動・維持はホストが担当し、stdoutはMCP JSON-RPC専用です。

| ツール | 引数 | すること |
| --- | --- | --- |
| `auth_start` | `{"profile": {…}}` | 認証を開始し、sessionの `id`・Googleの `url`・状態をすぐ返す |
| `auth_status` | `{"id":"SESSION_ID"}` | メモリ内の認証sessionを確認 |
| `auth_save_retry` | `{"id":"SESSION_ID"}` | 検証後の保存失敗を、再同意なしでリトライ |
| `auth_cancel` | `{"id":"SESSION_ID"}` | キャンセル。保存開始済みなら完了を待つ |
| `scopes_list` | `{}` または後述の確認オプション | scope一覧と任意のAPI有効状態を取得 |
| `refresh` | `{"profile":"personal"}` | 保存済みprofileを更新し、メタデータを返す |
| `profile_status` | `{"profile":"personal"}` | リモート更新せず、保存済みメタデータを読む |

ファイルのクライアントを使い、1Passwordへ保存する `auth_start` 引数の例：

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

入力元は `{"env":"GOOGLE_OAUTH_CLIENT_JSON"}` や `{"op":{"vault":"CLIENT_VAULT_ID","item":"OAUTH_CLIENT_ITEM_ID"}}` も使えます。ファイル保存は `{"kind":"json","path":"/absolute/private/path/personal.json"}`、または `kind: "env"` と任意の `prefix` です。

`scopes_list` は任意の `projectId`・`api` と、`cloudTokenEnv`・`cloudTokenFile`・`cloudTokenOp` のいずれかを受け取ります。最後のものは `vault`・`item`・任意の `field` / `tokenEnv` のオブジェクトです。クライアントのop参照は `tokenEnv`・`clientIdField`・`clientSecretField`・`projectIdField`・`type`、保存先のop参照は `item` または `title`、`tokenEnv`・`refreshField` に対応します。秘密値ではなく変数名を指定します。未知のschema keyは拒否します。

流れは**開始 → 人間がURLを開いて同意 → 状態確認 → saved**。サーバーごとに同時に1件のsessionを扱い、`save-failed` もその1件に含みます。sessionはメモリ内だけに存在し、有効時間は30分です。切断時はキャンセルしてcallback listenerを閉じますが、保存済みのprofile・認証情報は残ります。トークンを返すツールも、任意の子コマンドを実行するツールもありません。

## 同梱のエージェントSkill

[Skill](skills/grantloom/SKILL.md)は、安全な参照先を質問し、CLIを使い、ログイン・多要素認証・同意を人間へ引き継ぐ手順書です。別の常駐サーバーではありません。ロボットに受付のバインダーは渡せても、指紋まで貸す必要はありません。

`$HOME/.codex/skills` を読むエージェント向けには、次のように同梱ファイルを配置できます。

```sh
npm install -g grantloom@0.1.0
mkdir -p "$HOME/.codex/skills/grantloom"
cp "$(npm root -g)/grantloom/skills/grantloom/SKILL.md" \
  "$HOME/.codex/skills/grantloom/SKILL.md"
```

必要に応じてSkillを再読み込みしてください。別のエージェントでは配置先が異なる場合があります。Skillは認証情報ファイルや1Passwordの秘密fieldをチャットへ読み込むこと、秘密値の表示、認証確認のための環境変数ダンプを禁止します。主な入口はCLIで、MCPは任意です。

## 認証の裏側で何をしている？

1. 同意前にクライアント・profile設定と保存先を確認。
2. `127.0.0.1` に一時的なHTTP callback listenerを起動。
3. PKCE S256・ランダムなstate・OIDC nonceを付けてGoogle同意を開始。
4. 一度きりのcallbackを検査し、Google公式ライブラリでID tokenを検証。確認済みメールアドレスと指定アカウントを照合。
5. 実際の付与scopeとrefresh tokenの存在を確認。
6. refreshを一度実行し、更新後のaccess tokenも検証。
7. 保存後に読み直して一致を確認し、profileを保存。
8. メタデータ付きで `saved` を報告。トークンは舞台裏で待機。カーテンコールもありません。

Googleログイン・API呼び出しにはGoogleのサービスを、1Password保存には設定したVaultアクセスを使います。「独自の認証サーバーなし」は、Grantloomが新たなリモート認証backendを挟まないという意味です。

## 困ったときは

| 症状 | 確認すること |
| --- | --- |
| `INVALID_CONFIG` / `INVALID_CLIENT` | 引数、非対話環境の必須項目、JSONの型、元のクライアント入力 |
| `STORE_NOT_FOUND` | profile名、`GRANTLOOM_CONFIG_DIR`、保存先、1Passwordアクセス |
| `STORE_UNSAFE` | 親ディレクトリを含めて安全な権限の非公開パスか。symlink保存先を避ける |
| `STORE_CONFLICT` | 別アカウント・別クライアント・別scopeには別の保存先・profileを使う |
| `STORE_AMBIGUOUS` | 1Passwordの同名項目を整理するか、互換項目のIDを指定 |
| `ACCOUNT_MISMATCH` | 指定したGoogleアカウントで同意し直す |
| `SCOPES_MISSING` | 全scopeに同意したか、アプリ・管理者の制限がないか |
| `REFRESH_MISSING` | 同意し直し、Googleのrefresh token発行条件を確認 |
| `TOKEN_EXPIRED` | `grantloom refresh --profile personal --json` 後にスクリプトを再実行 |
| `OAUTH_DENIED` / `OAUTH_FAILED` | 同意画面、テストユーザー、Workspaceポリシー |
| `FILE_STORE_UNSUPPORTED` | Windowsでは1Passwordを使う |
| ブラウザが開かない | 同意URLを手動で開き、CLIは起動したままにする |

**保存に失敗したら：** 対話CLIは検証済みの認証情報をメモリに保持し、`retry` / `cancel` を質問します。MCPでは同じsession IDで `auth_save_retry` を呼びます。保存先の権限などを直し、そのsession内で再試行できます。非対話CLIは失敗を報告して、終了時に保持中のsessionを破棄します。

**キャンセルしたら：** Ctrl-Cで同意待ち・検証中の処理をキャンセルします。保存開始後は、書き込み・読み戻し・profile保存の完了を待ちます。成功した保存は `saved` のまま、失敗した保存はキャンセルとして報告します。rollback・トークン失効はせず、保存失敗後に認証情報が一部残る場合があります。

**後日トークンが使えなくなったら：** refresh tokenにも失効・取り消しがあります。ExternalアプリのTestingでは通常7日間で、本人確認だけのscopeなどに例外があります。Gmail scopeに関わるパスワード変更、管理者ポリシー、発行数の上限なども影響します。[Google公式の有効期限ルール](https://developers.google.com/identity/protocols/oauth2#expiration)を確認してください。「refresh」は更新可能という意味で、永久会員証ではありません。

**lockが残ったら：** 書き込みプロセスが強制終了すると `.grantloom.lock` が残る場合があります。動作中のwriterがいないことを確認してから削除してください。ファイルはatomic置換しますが、directory fsyncによるクラッシュ耐久性までは保証しません。1Password更新にもリモートのcompare-and-swap保証はありません。

## 開発とライセンス

```sh
npm ci
npm test
npm run check
npm pack --dry-run
```

Google公式認証ライブラリ、公式MCP SDK、Node標準のHTTP・ファイル・子プロセス・テスト機能を使っています。CIはLinux/macOSのNode 22/24と、WindowsのNode 24でprofile・helpの重点確認を実施します。テストはダミーの認証情報と制御された通信先を使います。

ドキュメント：[English](README.md) · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)。[MITライセンス](LICENSE)です。
