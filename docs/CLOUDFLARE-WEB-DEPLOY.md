# Cloudflare 网页部署（连接 GitHub，全程不用命令行）

适合已经在 Cloudflare 后台绑定了 GitHub 账号的情况。
全程在 Cloudflare 网页 + GitHub 网页上点，唯一要手填的是 D1 的 Database ID。

> 如果你更习惯命令行，看根目录 `README.md` 的「方式一」即可，两边效果一样，**不要同时用**。

---

## 开始前：只记一句话

**Worker 的名字必须叫 `ques-service`**，必须和仓库里 `workers/wrangler.jsonc` 的 `"name": "ques-service"` 完全一致，否则构建会直接失败。

---

## 第 1 步：创建 D1 数据库

1. 打开 Cloudflare 控制台 → 左侧 **「存储和数据库」→「D1 SQL 数据库」**
   （英文界面：*Storage & Databases → D1 SQL Database*）
2. 点 **创建 / Create**
3. 名字填：`ques-service-db`
4. 创建完成后，进入这个数据库，**复制 Database ID**（一长串 UUID）

---

## 第 2 步：把 Database ID 填进仓库

> **先说清楚一件事：Database ID 不是密钥。**
> 它只是你账号下那个 D1 数据库的「编号」（一串 UUID），别人拿到它**读不到你的数据** ——
> 要读写 D1 必须通过 Cloudflare 账号登录或持有 API Token。
> 所以把它写进仓库，安全性上问题不大（GitHub 上大量公开项目都这么干）。
> 真正在意的应该是 `TOKEN_SECRET`（第 5 步），那个走 Secret，不进仓库。
>
> 如果就是不想让它出现在仓库里，用 **做法 B**。

### 做法 A：直接在 GitHub 网页改文件（推荐，最简单）

1. 浏览器打开 `https://github.com/ahlson/ques-service`
2. 依次点进 `workers` 文件夹 → 点 `wrangler.jsonc`
3. 右上角 **铅笔图标（Edit this file）** —— 就在「Raw / Blame」那排按钮旁边
4. 找到这一行：

   ```
   "database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID",
   ```

   把引号里的占位符换成第 1 步复制的 ID：

   ```
   "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
   ```

5. 页面拉到最下面 → **Commit changes** → 直接提交到 `main`
   （这一步也可以在你电脑上改完 `git push`，效果完全一样）

> 提交会触发一次构建；如果这时 Cloudflare 还没连仓库，不会有任何反应，属于正常。

### 做法 B：不写进仓库，用 Secret 注入（可选）

仓库里已经带了一个生成脚本 `workers/scripts/gen-wrangler.js`：
它读环境变量 `D1_DATABASE_ID`，生成一个**不会被提交**的 `wrangler.deploy.jsonc`，再用它部署。

配置步骤：

1. Cloudflare → **Workers 和 Pages** → `ques-service`
   → **Settings → 变量和机密 / Variables and Secrets** → **Add**
2. 类型选 **Secret（加密）**：Name 填 `D1_DATABASE_ID`，Value 填第 1 步的 Database ID
3. 再到 **Settings → Build** ，把 **Deploy command** 改成：

   ```
   npm run deploy:ci
   ```

   （等价写法：`node scripts/gen-wrangler.js && npx wrangler deploy --config wrangler.deploy.jsonc`）

4. 保存后 **Retry build** 一次

这样仓库里的 `wrangler.jsonc` 始终保留占位符，真实 ID 只存在 Cloudflare 上。
第 4 步「建表」如果也想自动跑，把 Build command 改成：

```
npm install && npm run deploy:ci && npx wrangler d1 migrations apply ques-service-db --remote
```

> 没配 `D1_DATABASE_ID` 时脚本会直接报错退出并提示原因，不会带着占位符部署出一个坏版本。

---

## 第 3 步：连接仓库并创建 Worker

1. Cloudflare 控制台 → **Workers 和 Pages**
   （英文：*Workers & Pages*，新版叫 *Compute (Workers)*）
2. 点 **创建应用程序 / Create**
3. 选 **Import a repository**（从仓库导入）这一栏的 **Get started**
4. 选你的 GitHub 账号 → 选仓库 **`ahlson/ques-service`**
5. 按下面填（**这几项是关键，别用默认值**）：

   | 配置项 | 填什么 |
   |---|---|
   | **Project name / Worker 名** | `ques-service` ⚠️ 必须一致 |
   | **Production branch** | `main` |
   | **Root directory**（根目录） | `workers` |
   | **Build command**（构建命令） | `npm install` |
   | **Deploy command**（部署命令） | `npx wrangler deploy` |

6. 点 **Save and Deploy**

第一次构建大约 1～3 分钟。构建成功会给你一个地址：
`https://ques-service.xxxxx.workers.dev`

> 如果 Root directory 填了 `workers` 却报找不到 `public` 目录（极少见）：
> 把仓库里 `workers/wrangler.jsonc` 的 `"directory": "../public"` 改成 `"directory": "./public"`，
> 同时把仓库根目录的 `public/` 整个复制一份到 `workers/public/` 再提交。

---

## 第 4 步：确认 D1 绑定（binding）已挂上

「绑定」就是让 Worker 代码里能用 `env.DB` 访问到你的 D1 库。名字必须叫 **`DB`**，写死在代码里。

### 用 Git 集成（第 3 步那套）时：不用手动加

`workers/wrangler.jsonc` 里已经声明了绑定，部署时 wrangler 会自动挂上。
部署完去这里确认一眼：

**Workers 和 Pages → ques-service → Settings → Bindings（绑定）**
应该能看到一行：**D1 database · 变量名 `DB` · ques-service-db**

> 没看到？说明 `wrangler.jsonc` 里的 `database_id` 还是占位符，或者 Worker 名不一致，回到第 2 步检查。

### 如果你是手动创建的 Worker：在这里加

1. **Workers 和 Pages** → 点 `ques-service`
2. **Settings → Bindings（绑定）** → **Add（添加）**
3. 类型选 **D1 database**
4. **Variable name（变量名）** 填：`DB` ← 必须是这个，不能改
5. **D1 database** 下拉选：`ques-service-db`
6. 点 **Save / Deploy**

> 注意：一旦改用 Git 集成（Workers Builds）部署，云端会按 `wrangler.jsonc` 重新生成绑定，
> 手动加的那条可能被覆盖成同名 `DB`（结果一样，不影响使用）。

---

## 第 5 步：建表（执行 migrations）

D1 是空库，必须建表，否则页面能开但登录报 500。

**要执行两个文件**（缺了第二个，题库分组功能会报错）：

| 文件 | 内容 |
|---|---|
| `workers/migrations/0001_init.sql` | 用户、题目、考试记录、错题本、已练记录 |
| `workers/migrations/0002_banks.sql` | 题库分组表 `question_banks`、`bank_acl`，`questions` 加 `bank_id` |

### 方法 A：在网页上直接跑 SQL（推荐，最稳）

1. Cloudflare → **存储和数据库 → D1** → 点 `ques-service-db`
2. 切到 **控制台 / Console** 标签
3. 打开仓库里的 **`docs/d1-console-all.sql`**（这是 0001+0002 合并好的纯净版），**全选复制**
4. 粘贴到 Console 的输入框 → 点 **Execute / Run**
5. 看到执行成功即可

> 如果之前已经手动跑成功过 `0001_init.sql`（表已存在但缺 `bank_id`），
> 再单独执行这一行补列即可：
> `ALTER TABLE questions ADD COLUMN bank_id;`
> 想知道现在到底有哪些表，在 Console 里跑：
> `SELECT name FROM sqlite_master WHERE type='table';`

**⚠️ 报错 `The request is malformed: Requests without any query are not supported.`**

这是因为粘贴的内容里**注释行和 SQL 语句挤在同一行**了（典型情况：`-- Migration number: 0001 -- 说明 CREATE TABLE ...`，
整行都会被当成注释，D1 收到的实际语句数是 0）。

处理办法三选一：

- **用 `docs/d1-console-all.sql` 纯净版**（不含任何注释行），一次跑完
- 或者复制时把开头两行 `--` 注释**删掉**，从 `CREATE TABLE` 开始粘
- 或者**分次执行**：一次只粘一条 `CREATE TABLE ... ;`

### 方法 B：让每次构建自动跑迁移

把第 3 步的 **Build command** 改成：

```
npm install && npx wrangler d1 migrations apply ques-service-db --remote
```

改完在 **Deployments** 里 **Retry build** 一次。
wrangler 会自动按顺序应用 `migrations/` 下所有文件（0001、0002 都跑），以后加新表也一样自动升级。
（Workers Builds 会自动生成 API Token，不需要你额外配置密钥。）

---

## 第 6 步：设置 TOKEN_SECRET（重要）

登录 Token 的签名密钥，不设就用默认值，等于门没锁。

1. Cloudflare → **Workers 和 Pages** → 点 `ques-service`
2. **Settings → 变量和机密 / Variables and Secrets** → **Add**
3. 类型选 **Secret（加密）**，不要选 Text
4. Name：`TOKEN_SECRET`
5. Value：随便一个长随机串（例如用密码生成器生成 32 位）
6. Save
7. **重新部署才生效**：到 **Deployments** → 最新一条 → **Retry build**
   （或在 GitHub 上随便改个文件提交一次）

> 这里设置的是「机密」，会覆盖 `wrangler.jsonc` 里 `vars.TOKEN_SECRET` 的默认值，所以不用改仓库文件。

---

## 第 7 步：初始化管理员 + 导入题库

1. 打开 `https://ques-service.xxxxx.workers.dev`
2. 因为库里还没有任何账号，登录页会显示 **「初始化」** → 创建第一个账号（**这个账号就是管理员**）
3. 登录后进 **管理后台 → 批量导入**
4. 上传题库 CSV（模板表头：`题号,题干,A,B,C,D,E,答案,难度,题型`）→ 点 **开始导入**
5. 1120 题会自动分片上传（约 8 片），显示进度，报成功条数

导入完就可以正常刷题了。

---

## 第 8 步（必做）：创建学员账号并分配题库

系统**不开放自助注册**，学员账号只能由管理员创建。

1. 管理后台 → **用户管理 → + 新增用户**：填用户名、初始密码、角色（默认普通用户）
2. 把账号密码告诉学员
3. **批量导入** 时如果选了「只给指定用户」，记得勾选对应用户；
   也可以事后在 **题库管理 → 授权** 里勾选，或在 **用户管理 → 题库权限** 里给单个用户勾选题库
4. 学员登录后进「我的题库」能看到管理员分配给他的题库；他自己上传的题库只有他和管理员可见

> 你自己的管理员账号登录后**只能进管理后台**，看不到刷题入口（纯管理账号），这是设计如此。

## 第 9 步（国内访问必做）：绑自己的域名

### 为什么必须绑

`*.workers.dev` 这个后缀在国内被 SNI 阻断，DNS 能解析但握手就断，浏览器直接超时。
**不是你的部署有问题，是这个域名本身到不了。** 换成自己的域名后即可正常访问。

### 硬前提：域名必须和 Worker 在「同一个 Cloudflare 账号」

Cloudflare 只允许给本账号下的域名绑 Worker。跨账号不行，常见两种错误做法：

| 做法 | 结果 |
|---|---|
| 在另一个账号里加 `CNAME ques → ques-service.asksonglh.workers.dev`（开代理） | **Error 1014 CNAME Cross-User Banned** |
| 同上但关代理（灰云） | Host 头仍是你的域名，`workers.dev` 不认，照样打不开 |

所以只有下面三条路，选一条：

### 方案 A：把域名迁到 Worker 所在账号（推荐）

适合这个域名没别的重要业务，或你愿意一起搬。

1. 在 **Worker 所在账号** 里： Websites → **Add a site** → 输入域名 → 选 **Free**
2. Cloudflare 会给你两个名字服务器（如 `xxx.ns.cloudflare.com`）
3. 去**注册商**那里把域名的 NS 改成这两个（若是 Cloudflare 注册的域名，用
   **Domain Registration → Manage Domain → Configuration → Move domain to another account**）
4. 把旧账号里的 DNS 记录导出、在新账号里导入（**DNS → 导出 / Import**）
5. NS 生效后（几分钟到几小时），回来做绑定

### 方案 B：把 Worker 整套部署到「有域名的那个账号」（DNS 零改动）

适合域名上还挂着别的服务、不想动 DNS。

在那个账号里重做一遍：建 D1 → 填 `database_id` → 建表 → 设 `TOKEN_SECRET` → 部署 → 绑域名。
题库要重新导入一次（用本地的 `题库合并.csv`，1120 题，几分钟）。
给我那个账号的 API Token（Workers + D1 写权限）我可以代做。

### 方案 C：子域名委派

在旧账号给子域加 NS 记录，指向新账号的名字服务器，子域归新账号管、主域不动。
**需要 Business 及以上套餐**，免费版用不了。

### 方案 D：两边都不动 —— 在域名所在账号建一个转发 Worker

适合「域名不想迁、Worker 也不想迁」。思路：在账号 B 建一个只做转发的 Worker，
把 `ques.你的域名.com` 的请求原样转发给账号 A 的 Worker。

代码在仓库里的 **`docs/reverse-proxy-worker.js`**，整段复制即可。步骤：

1. 登录**有域名的那个账号** → **Workers 和 Pages → 创建 → 创建 Worker**
   → 名字随便（如 `ques-proxy`）→ 部署
2. 点 **编辑代码**，删掉默认内容，粘贴 `docs/reverse-proxy-worker.js` 的全部内容，
   把第一行 `ORIGIN` 改成你自己的 `workers.dev` 地址
3. 点 **部署**
4. 该 Worker → **Settings → 域和路由 → 添加 → 自定义域** → 填 `ques.你的域名.com`

代价要清楚：**每次访问会跑两个 Worker**，免费版每天 10 万次请求的额度相当于减半；
延迟多一跳（一般几十毫秒）。能用，但长期看不如方案 A / B 干净。

### 关于「直接把域名解析过去」

结论是**不行**，三种试法都会失败：

| 试法 | 结果 |
|---|---|
| CNAME 到 `workers.dev`，开代理（橙云） | **Error 1014 CNAME Cross-User Banned**，Cloudflare 明确禁止跨账号 CNAME |
| CNAME 到 `workers.dev`，仅 DNS（灰云） | 请求的 Host 头还是你的域名，`workers.dev` 靠 Host/SNI 分流，认不出来，打不开 |
| 用页面重定向 / URL 转发跳到 `workers.dev` | 跳过去之后浏览器访问的还是 `workers.dev`，国内依旧被拦，等于没换 |

### 绑定操作（域名已在本账号后）

**Workers 和 Pages → ques-service → Settings → 域和路由 / Domains & Routes → Add → Custom domain**
填你要的子域名，例如 `ques.你的域名.com`，Cloudflare 会自动建 DNS 记录和证书，等几分钟生效。

> 绑完后 `ques-service.asksonglh.workers.dev` 依然能访问，两个地址指向同一套服务。

### 国内访问预期

换自定义域名后国内一般可直连，但 Cloudflare 没有中国大陆节点，速度和稳定性随运营商、
时段波动，晚高峰可能明显变慢。**如果对稳定性要求高**（要给客户/学员正式用），
建议走 Docker 版部署到国内服务器 + 已备案域名，那条路最稳。

---

## 关于仓库里那个 GitHub Action

`.github/workflows/deploy.yml` 是**另一套**自动部署（GitHub Actions 版），和上面的 Workers Builds 功能重复。

现在已经加了保护：**没配置 `CLOUDFLARE_API_TOKEN` 时它会自动跳过**，不会报红叉。
所以默认状态下它不起作用，你用网页这套就行。

如果想改用 GitHub Actions 那套（比如需要更灵活的构建流程），去仓库
**Settings → Secrets and variables → Actions** 添加 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 即可 —— 但记得把 Cloudflare 网页里的自动部署关掉（**Settings → Build → Disconnect**），避免两边重复部署。

---

## 常见报错

| 报错 | 原因 / 处理 |
|---|---|
| `Worker name does not match` / 构建直接失败 | Worker 名不是 `ques-service`，改成和 `wrangler.jsonc` 的 `name` 一致 |
| 页面能开，登录报 500 或「请先登录」 | D1 没建表，回去做第 5 步 |
| `Requests without any query are not supported` | 粘贴的 SQL 里注释和语句在同一行，删掉注释或改用 `d1-console-all.sql` |
| `Could not find database` / DB binding 报错 | `wrangler.jsonc` 里的 `database_id` 还是占位符，或绑定变量名不是 `DB` |
| `no such table: question_banks` | 只跑了 `0001_init.sql`，还差 `0002_banks.sql` |
| 构建成功但页面 404 白屏 | Root directory 没填 `workers` |
| 页面能开、`/api/*` 全是 404 且响应体为空 | 这次部署只上传了静态资源、Worker 脚本没上去；重新 `wrangler deploy` 一次 |
| `Error 1014 CNAME Cross-User Banned` | 想跨账号 CNAME 到 `workers.dev`，不被允许；见第 9 步 |
| 绑自定义域名时提示找不到域名 | 域名不在当前 Cloudflare 账号，见第 9 步 |
| 导入题库一直失败 | 看导入结果里列出的行号和原因；CSV 必须是 UTF-8 编码 |
| 改完 `TOKEN_SECRET` 后所有人被踢下线 | 正常，密钥变了旧 Token 就失效了 |

---

## 以后怎么更新

直接在 GitHub 上改代码提交到 `main`，Cloudflare 会自动重新构建部署。
想看构建日志：**Workers 和 Pages → ques-service → Deployments → 点某条 → View build log**。
