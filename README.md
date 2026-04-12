# 白鹿缘摄影 · 作品管理系统部署指南

## 架构概览

```
前端 (index.html)  ←→  Cloudflare Worker API  ←→  Cloudflare D1 (元数据)
                                        ↕
                               Cloudflare R2 (图片存储)

管理后台 (admin/index.html)  ←→  同一个 Worker API
```

## 前置要求

- Cloudflare 账号
- 安装 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Node.js 18+

## 部署步骤

### 1. 登录 Cloudflare

```bash
wrangler login
```

### 2. 创建 D1 数据库

```bash
cd worker
wrangler d1 create bailuyuan-portfolio
```

记录输出中的 `database_id`，然后更新 `wrangler.toml` 中的 `database_id`。

### 3. 初始化数据库表结构

```bash
# 本地开发环境
wrangler d1 execute bailuyuan-portfolio --local --file=schema.sql

# 生产环境
wrangler d1 execute bailuyuan-portfolio --remote --file=schema.sql
```

### 4. 创建 R2 存储桶

```bash
wrangler r2 bucket create bailuyuan-images
```

### 5. 安装依赖并部署 Worker

```bash
cd worker
npm install
wrangler deploy
```

部署成功后会得到一个地址，类似：
`https://bailuyuan-portfolio-api.YOUR_SUBDOMAIN.workers.dev`

### 6. 更新 API 地址

将 Worker 地址填入以下两个文件：

**前端 `index.html`**（第 ~738 行附近）：
```javascript
const API_BASE = 'https://bailuyuan-portfolio-api.YOUR_SUBDOMAIN.workers.dev';
```

**管理后台 `admin/index.html`**（第 ~420 行附近的 script 中）：
```javascript
const API_BASE = 'https://bailuyuan-portfolio-api.YOUR_SUBDOMAIN.workers.dev';
```

### 7. 部署前端

将 `index.html` 和 `admin/index.html` 部署到你的静态托管服务（Cloudflare Pages、Vercel 等）。

```bash
# 使用 Cloudflare Pages
wrangler pages project create bailuyuan-studio
wrangler pages deploy . --project-name=bailuyuan-studio
```

## 使用管理后台

1. 访问 `https://你的域名/admin/`
2. 点击「添加作品」上传图片和填写信息
3. 可以编辑、删除已有作品
4. 支持按分类筛选和搜索

## API 接口

| 方法   | 路径               | 说明         |
|--------|-------------------|-------------|
| GET    | /api/works        | 获取所有作品  |
| GET    | /api/works/:id    | 获取单个作品  |
| POST   | /api/works        | 创建作品      |
| PUT    | /api/works/:id    | 更新作品      |
| DELETE | /api/works/:id    | 删除作品      |
| GET    | /api/image/:key   | 获取图片      |

## 安全建议

生产环境建议：
1. 在 Worker 中添加管理员认证（如 Bearer Token）
2. 限制 CORS 允许的域名
3. 添加图片大小和类型验证
4. 配置 Rate Limiting

## 文件结构

```
myFirstProject/
├── index.html          # 前端页面（已改造为动态加载）
├── admin/
│   └── index.html      # 管理后台（单文件，开箱即用）
├── worker/
│   ├── src/
│   │   └── index.js    # Worker API 代码
│   ├── schema.sql      # D1 建表语句
│   ├── wrangler.toml   # Wrangler 配置
│   └── package.json
└── README.md           # 本文件
```
