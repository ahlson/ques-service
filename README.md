# 在线答题系统（ques-service）

专项刷题 · 模拟考试 · 错题本 · 成绩管理 · 后台题库维护。

同一套代码支持 **两种部署方式**，按需二选一：

| 部署方式 | 运行环境 | 数据库 | 适合场景 |
|---|---|---|---|
| **Cloudflare Workers** | Cloudflare 全球边缘网络 | **D1**（Serverless SQLite） | 免服务器、免运维、公网访问、按量免费额度 |
| **Docker / Node** | 自建服务器或本机 | **SQLite**（`data/quiz.db`） | 内网部署、数据完全自控、离线可用 |

两种方式的**前端页面、接口、业务逻辑完全一致**（共用 `shared/` 目录）。

---

## 角色与权限（重要）

系统只有两种角色，且**不开放自助注册**：

| | 管理员 | 普通用户 |
|---|---|---|
| 怎么来的 | 第一个账号由「初始化」页面创建，之后由管理员在后台新建 | 只能由管理员在后台创建 |
| 登录后看到 | **只有管理后台**（纯管理，不刷题、不考试） | 首页 / 刷题 / 错题 / 考试 / 我的题库 / 成绩 |
| 题库 | 看得到**全部**题库，可建库、改授权、删除 | 只看得到被授权的题库 |
| 上传题库 | 可以，并可勾选「给哪些用户用」 | 可以，**默认只有自己和管理员能看见** |

**题库的三种可见范围**

1. **全体可见**：管理员发布，所有登录用户都能练
2. **指定用户**：管理员在题库上勾选授权对象，只有被勾选的人能练
3. **用户私库**：用户自己上传，本人 + 管理员可见（管理员可再转授给其他人）

服务端也做了拦截：管理员直接调刷题/考试接口会返回 403，绕过页面也不行。
管理员不能取消自己的管理员权限、不能删除自己，系统至少保留一个管理员。

详细操作见 [docs/CLOUDFLARE-WEB-DEPLOY.md](docs/CLOUDFLARE-WEB-DEPLOY.md) 第 6 步之后的使用说明。

---

## 目录结构

```
ques-service/
├── shared/                 # ★ 两种部署方式共用的业务核心
│   ├── auth.js             #   密码哈希（PBKDF2）+ 签名 Token（HMAC），纯 Web Crypto
│   ├── questions.js        #   题型规范化、判分、题库 CSV/文本导入解析
│   └── api-core.js         #   全部接口路由（与框架无关）
├── public/                 # ★ 共用前端页面
├── workers/                # Cloudflare Workers 部署
│   ├── wrangler.jsonc
│   ├── migrations/0001_init.sql
│   ├── src/index.js        #   Hono 入口
│   └── src/db-d1.js        #   D1 适配器
├── server.js               # Node/Express 入口（Docker 用）
├── lib/db-sqlite.js        # SQLite 适配器
├── schema.sql              # SQLite 建表脚本
├── scripts/init.js         # 建表 + 创建默认账号（+ 可选导入题库）
└── Dockerfile
```

---

## 方式一：部署到 Cloudflare Workers

两种做法，**二选一**：

- **A. 网页部署（推荐）**：在 Cloudflare 后台连接 GitHub，全程点鼠标，push 即自动部署
  → 见 **[docs/CLOUDFLARE-WEB-DEPLOY.md](docs/CLOUDFLARE-WEB-DEPLOY.md)**
- **B. 命令行部署**：下面 1~6 步

> 若用 A，仓库里的 `.github/workflows/deploy.yml` 会因未配置密钥自动跳过，不会冲突。

### 1. 准备

```bash
cd workers
npm install
npx wrangler login          # 浏览器授权 Cloudflare 账号
```

### 2. 创建 D1 数据库

```bash
npm run d1:create
```

命令会输出一段 `database_id`，把它填回 `workers/wrangler.jsonc` 的 `database_id` 字段里。

### 3. 建表

```bash
npm run d1:migrate          # 对线上 D1 执行 migrations/0001_init.sql
```

### 4. 设置 Token 密钥（重要）

```bash
npm run secret
# 提示输入时，给一个足够长的随机字符串
```

### 5. 部署

```bash
npm run deploy
```

完成后会给出访问地址，例如 `https://ques-service.<你的子域>.workers.dev`。

### 6. 初始化 + 导入题库

1. 打开站点 → 系统检测到还没有账号，会显示「**初始化**」页面，创建第一个账号（即管理员）。
2. 登录后进入「**管理后台 → 批量导入**」，上传题库 CSV，点「开始导入」。

> Workers 单次请求有体积与参数上限，前端会自动把大文件按 150 行分片上传并显示进度，1120 题约 8 片即可导完。

---

## 方式二：Docker / Node 部署

### Docker

```bash
# 构建（在仓库根目录执行）
docker build -t ques-service .

# 运行（务必挂载数据卷，否则重建容器会丢数据）
docker volume create ques-data
docker run -d --name ques-service --restart unless-stopped \
  -p 3000:3000 \
  -e TOKEN_SECRET=换成你的随机字符串 \
  -v ques-data:/app/data \
  ques-service

# 首次建表 + 创建默认账号
docker exec ques-service npm run init
```

默认账号：`admin / admin123`（管理员）、`user / user123`（学员）。
**登录后请在管理后台改密码或尽快导入题库。**

访问：`http://服务器IP:3000`

### 本机 Node

```bash
npm install
npm run init        # 建表 + 默认账号（可选：npm run init -- --csv 题库.csv）
npm start
```

---

## 题库导入说明

**题目不再随仓库附带，也不再由初始化脚本写入**，全部改为登录后在网页导入，Cloudflare 与 Docker 两种部署方式操作完全一致。

**一次导入 = 一个题库。** 导入时给题库起个名字，之后就能按整个题库授权给指定用户，也可以单独删除。

- **管理员**：管理后台 → 批量导入（填题库名 → 选「全体可见」或勾选指定用户 → 上传文件）
- **普通用户**：我的题库 → 上传我的题库（自动成为私库，只有自己和管理员可见）

管理后台 → 批量导入，支持两种格式，系统自动识别：

### 格式一：模板 CSV（推荐）

表头：`题号,题干,A,B,C,D,E,答案,难度,题型`

```
1,安全生产工作的方针是（ ）。,安全第一,预防为主,综合治理,以上都是,D,无,单选题
2,特种作业人员必须持证上岗。（ ）,正确,错误,,,,A,判断,单选题
```

- `难度` 列写 **判断** → 判为判断题（选项为 正确/错误，答案填 `A` 或 `B`）
- 否则按 `题型` 列的 **单选题 / 多选题** 处理，答案为字母（多选如 `ABCD`）
- E 列可留空；多选题答案多个字母自动升序去重
- 表头顺序可不同，按列名定位

### 格式二：竖线分隔文本

```
单选|查询数据用什么语句？|INSERT|UPDATE|SELECT|DELETE|C|SELECT 用于查询
多选|下列属于前端框架的有？|Vue|React|MySQL|Angular|ABD|MySQL 是数据库
判断|HTTP 默认端口是 80。|||||正确|常识题
```

以 `#` 开头的行会被忽略；解析可省略；选项个数 2~6 均可，系统会自动定位答案列。

### 重新导入前

先点「**清空题库**」再导入，避免题目重复累积（清空会同时删除答题记录与错题本）。

---

## 刷题不重复的机制

随机抽题天然会有「刷了很多轮仍有题没碰到」的问题（1120 题每轮 200 题，纯随机要 30+ 轮才能凑齐）。本系统的处理：

- **只出没做过的新题（默认）**：每答一题立刻写入 `practice_seen` 表，下一轮只抽没做过的；刷完提示「已全部练完」。中途退出也不会丢记录。
- **未做过的优先**：没做过的排前面，不足一轮题量时才用旧题补足。
- **完全随机**：保留最初的纯随机行为。

刷题页实时显示「共 X 题 · 已练 Y 题 · 还有 Z 题没练到」。

---

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `TOKEN_SECRET` | 登录 Token 签名密钥，**生产环境必须修改** | `please-change-this-secret` |
| `DB_PATH` | SQLite 文件路径（仅 Docker/Node） | `./data/quiz.db` |
| `PORT` | 监听端口（仅 Docker/Node） | `3000` |

Workers 版本用 `wrangler secret put TOKEN_SECRET` 设置，不要写在配置文件里。

---

## 从旧版本升级

旧版（v1~v3）用 Node `scrypt` 存储密码，新版统一为 Web Crypto 的 PBKDF2。
Docker 版本内置兼容：用旧密码登录时会自动校验成功并把哈希升级为 PBKDF2，无需手动重置。

---

## 常见问题

**Q：页面能打开但提示「请先登录」/ 接口 500？**
A：Workers 版本先确认 D1 已执行 migrations（`npm run d1:migrate`），且 `database_id` 填写正确。

**Q：Docker 重建容器后数据没了？**
A：说明没挂数据卷。请用 `-v ques-data:/app/data`，或先 `docker cp ques-service:/app/data/quiz.db ./quiz.db.bak` 备份。

**Q：怎么给别人开通账号？**
A：系统不开放注册。管理员在「管理后台 → 用户管理 → + 新增用户」创建，设置初始密码后告知对方即可。

**Q：为什么我登录进去只有管理后台，没有刷题入口？**
A：你登录的是管理员账号，管理员是纯管理账号。要刷题请用普通用户账号登录。

**Q：导入题库报失败？**
A：导入结果会列出失败行号与原因，常见为「题干为空」「答案字母超出选项范围」「题型不合法」。
按上面格式说明调整即可；CSV 请用 UTF-8 编码。

---

## License

MIT
