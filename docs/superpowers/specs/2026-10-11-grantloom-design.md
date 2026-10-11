# Grantloom 初版設計

承認: 2026-10-11。ユーザーがPR・mainへのマージ・npm公開までの実行を指示。

## 提案

npm package / executable / GitHub repo名は `grantloom`。新repoは `ryoshin0830/grantloom`、public、MITライセンスを提案する。利用者が自分のGoogle OAuth clientを持ち込むCLIであり、Google公式ツールとの誤認を避ける説明をREADMEに置く。npmで名前が拒否された場合は本人のnpm scope配下へ変更し、bin名grantloomは保持する。npmアカウントはログイン後に本人所有を確認する。

Node.js 22以上のES Modules。OAuth/OIDCの処理はGoogle公式認証ライブラリ、MCPは公式SDKを使う。HTTP callback・ファイル保存・子プロセス・基本対話・testsはNode標準機能を使う。専用Web frameworkやhosted backendは作らない。

## 利用方法

`npx grantloom auth` がclient、account、scope、保存先を順に質問する。同じ項目を明示引数で指定すればCLI agentから起動できる。対話できない場面で不足した情報は、秘密値を含めず不足する項目名と終了コードを返す。

秘密値を引数に指定するオプションは提供しない。client JSONはファイルのパス、環境変数は変数名、1PasswordはVault/item/fieldを指定する。認証開始前にaccount・requested scopes・保存先を提示し、ユーザーがブラウザ上でログイン・同意する。

コマンド:

- `auth`: 新規認証と保存。CLIでは同意・保存完了まで待機。
- `scopes`: scope候補・用途説明・有効API確認状態を一覧表示。
- `refresh`: 保存済みrefresh tokenからaccess tokenを再発行し、同じ保存先を更新。
- `status`: account、scope、保存先、access token有効期限、検証状態のみを返す。
- `exec -- command`: 保存済みtokenを指定commandの子process環境へ注入する。
- `mcp`: stdio MCP server。

`--json`の結果にもtoken、client secret、codeは含めない。認証URLを出す場合はGoogleへの認証開始URLだけとし、codeを含むcallback URLは出さない。

## Client対応

初版はDesktop clientを標準対応とする。Web clientも登録済みのHTTP loopback redirect URIを明示した場合に対応する。Web clientでは登録URIと完全一致するhost/port/pathでlistenし、空きportを勝手に変えない。外部HTTPS callback・service account JSONは本ツールのユーザー同意フローに使えないことを案内する。

clientのproject_idはJSON/明示指定から取得する。client IDの文字列だけでproject_idやenabled APIsを推定しない。

## APIとscope選択

clientを読み込んだ後、projectと別途Cloud閲覧credentialが指定されている場合にService Usage APIでenabled servicesを取得する。ページング、timeout、認証・IAM不足を扱う。有効APIから一般的なscopeを提案するが、API有効化と同意可能なscopeを同一視しない。

Cloud閲覧credentialは環境変数/保護ファイル/1Password参照から指定する。Google API Discoveryと同梱した主要scopeカタログを使ってscope候補を提供する。Cloud権限がなければ「API有効状態未確認」と表示し、候補選択・scope URI直接指定を提供する。APIを勝手に有効化したり、Gmail用tokenにCloud閲覧scopeを勝手に追加したりしない。

本人照合のためopenidとemail scopeを明示的に追加し、認証前の一覧に表示する。

## 認証と検証

1. 保存先の存在、client形式、必要なop権限/ファイル書込権限を認証前に確認。
2. loopback serverを起動。127.0.0.1にのみbindし、state・PKCE S256・一度限りのcallback・30分timeoutを使用。
3. ブラウザでGoogleの通常ログイン・同意を実施。login_hintは補助であり本人照合の代わりにしない。
4. callbackのstateを検証し、codeをaccess/refresh tokenに交換。callback queryやGoogleのraw error responseはログへ出さない。
5. OIDCのissuer/audience/signature/nonceを公式ライブラリで検証し、email_verifiedと対象accountを照合。
6. 実際のgranted scopesをrequested scopesと照合。不足・別account・refresh欠落時は成功とせず、既存保存を上書きしない。
7. refresh grantでaccess token再発行を検証し、その最新access tokenとexpires_atを保存。
8. 保存後に再取得し、secret値は内部だけで比較。成功を非秘密metadataで報告。

保存失敗時はtokenをメモリに保持し、同じsession内で保存の再試行ができる。検証失敗と保存失敗を区別し、raw tokenを緊急表示する救済機能は作らない。終了・timeout時はsessionを破棄する。

## 保存

### 1Password

既存op login/Desktop連携またはservice accountを使う。service accountを選んだらtokenを格納している環境変数名を聞く。Vault、項目名/既存item ID、fieldを選択する。秘密値はop child processへのstdin/環境で渡し、stdout/stderrを捕捉して画面へ転送しない。

refresh_token、access_token、必要なclient_secretはCONCEALED。account、client reference、requested/granted scopes、取得日時、expires_at、検証結果を記録。別account・別client・別scopeの既存項目を自動上書きしない。refresh時の更新は対象item IDとaccount/client/scopeを照合してから行う。

### 環境変数ファイル

profile名に基づく変数名を提案し、変更できるようにする。例: `GRANTLOOM_WORK_REFRESH_TOKEN`、`GRANTLOOM_WORK_ACCESS_TOKEN`、`GRANTLOOM_WORK_ACCESS_TOKEN_EXPIRES_AT`。

指定ファイルへ直接書き、POSIXではdirectory700/file600・atomic write・symlink拒否・shell quotingを扱う。.zshrcに平文tokenを埋め込む代わりに、専用保護ファイルをsourceする設定例を示す。.zshrcの変更は利用者が選択した場合に行う。親shell環境をCLIが直接更新できないため、ファイルの読込みとexecによる子process注入を案内する。

初版の実動検証対象はmacOS/Linux。WindowsではPOSIX permission指定だけで安全と判断せず、1Password保存を使用し、envfile保存は非対応として明示する。

### ローカルJSON

Nodeが読める保護ファイルを選択肢にする。envfileと同じファイル保護・atomic write・上書き確認を行う。値はCLI/MCPの通常表示に出さない。

## MCP・Skill

MCPは`auth_start`、`auth_status`、`auth_save_retry`、`auth_cancel`、`scopes_list`、`refresh`、`profile_status`を提供する。auth_startは短時間でsession IDとbrowser開始URLを返す。localhost callback serverはMCP processが保持し、statusで完了確認する。sessionはメモリ内のみ、同時認証は1件、終了時破棄。token値を返すtoolと任意command実行toolは提供しない。

同梱SkillはCLIを主入口にし、ユーザーへ不足したaccount/scope/保存先を確認し、ブラウザ認証を引き継ぐ。secretファイルをcat/readしたり、opの秘密fieldをコンテキストへ取得したりしない。AI応答には保存先参照・account・scope・検証結果だけ載せる。

## テストと公開基準

OAuth transport、op、clock、browser openerはtestsで差し替えられる最小単位に分ける。Node標準test runnerでstate mismatch/replay/timeout、wrong account、partial scope、refresh欠落・失敗、保存失敗・再試行、item衝突、env escaping、symlink、既存token保全、CLI/MCP secret非表示を検証する。

Ponytail Reviewで変更・関連コード・READMEを確認し、修正後に検証する。npm packのfiles whitelist、tarballからのnpx実行、CI、git diff check、配布物/履歴へのsecret混入を確認してpush/publishする。公開後Registry metadataとnpx --helpを確認する。

Googleログイン・MFA・同意、npm login/MFAがユーザー操作を要求したら、その時点で引き継ぐ。

## 制約

Google Workspace管理者の制限、同意画面の公開設定、refresh token返却/寿命は本ツールが変更しない。認証成功を保証せず、原因を秘密値なしで説明する。CLI/MCPの出力を保護する設計であり、保存先へアクセスできる他ツールやexec先commandがsecretを表示することまで防ぐものではない。
