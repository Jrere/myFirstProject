import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

// CORS — 允许管理后台和前端跨域
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// ─── 健康检查 ───
app.get('/api/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

// ─── 获取所有作品 ───
app.get('/api/works', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM works ORDER BY sort_order ASC, created_at ASC'
  ).all();
  return c.json(results);
});

// ─── 获取单个作品 ───
app.get('/api/works/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(id).first();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json(row);
});

// ─── 创建作品（上传图片 + 写入元数据）───
app.post('/api/works', async (c) => {
  const formData = await c.req.formData();
  const name = formData.get('name') || '';
  const cn = formData.get('cn') || '';
  const category = formData.get('category') || 'corporate';
  const detail = formData.get('detail') || '';
  const sortOrder = parseInt(formData.get('sort_order') || '0', 10);
  const file = formData.get('image');

  if (!file || typeof file === 'string') {
    return c.json({ error: 'Image file is required' }, 400);
  }

  // 生成唯一文件名
  const ext = file.name.split('.').pop() || 'jpg';
  const key = `works/${crypto.randomUUID()}.${ext}`;

  // 上传到 R2
  await c.env.R2.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  // 写入 D1
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO works (id, name, cn, category, detail, image_key, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, name, cn, category, detail, key, sortOrder).run();

  const row = await c.env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

// ─── 更新作品元数据 ───
app.put('/api/works/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const formData = await c.req.formData();
  const name = formData.get('name') ?? existing.name;
  const cn = formData.get('cn') ?? existing.cn;
  const category = formData.get('category') ?? existing.category;
  const detail = formData.get('detail') ?? existing.detail;
  const sortOrder = formData.get('sort_order') != null
    ? parseInt(formData.get('sort_order'), 10) : existing.sort_order;

  let imageKey = existing.image_key;

  // 如果传了新图片，替换 R2 中的旧图
  const file = formData.get('image');
  if (file && typeof file !== 'string') {
    // 删除旧图
    if (imageKey) {
      await c.env.R2.delete(imageKey);
    }
    const ext = file.name.split('.').pop() || 'jpg';
    imageKey = `works/${crypto.randomUUID()}.${ext}`;
    await c.env.R2.put(imageKey, file.stream(), {
      httpMetadata: { contentType: file.type },
    });
  }

  await c.env.DB.prepare(
    'UPDATE works SET name=?, cn=?, category=?, detail=?, image_key=?, sort_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ).bind(name, cn, category, detail, imageKey, sortOrder, id).run();

  const row = await c.env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(id).first();
  return c.json(row);
});

// ─── 删除作品 ───
app.delete('/api/works/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ error: 'Not found' }, 404);

  // 删除 R2 图片
  if (existing.image_key) {
    await c.env.R2.delete(existing.image_key);
  }

  // 删除 D1 记录
  await c.env.DB.prepare('DELETE FROM works WHERE id = ?').bind(id).run();

  return c.json({ success: true });
});

// ─── 图片代理 — 通过 Worker 访问 R2 图片（可选）───
app.get('/api/image/:key{.*}', async (c) => {
  const key = c.req.param('key');
  const obj = await c.env.R2.get(key);
  if (!obj) return c.json({ error: 'Image not found' }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=86400');
  return new Response(obj.body, { headers });
});

export default app;
