export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ─── images.bailuyuan.fun 图片服务（支持自动压缩/格式转换）───
    if (url.hostname === 'images.bailuyuan.fun' && method === 'GET') {
      const rawPath = decodeURIComponent(pathname.slice(1));
      if (!rawPath) return new Response('Missing image key', { status: 400 });

      const width = parseInt(url.searchParams.get('w')) || 0;
      const quality = parseInt(url.searchParams.get('q')) || 82;
      const fmt = url.searchParams.get('f') || 'auto';

      // 用 Cache API 缓存优化后的图片（边缘命中，不回源 R2）
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), request);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;

      const obj = await env.R2.get(rawPath);
      if (!obj) return new Response('Image not found', { status: 404 });

      const headers = new Headers();
      obj.writeHttpMetadata(headers);

      const ext = rawPath.split('.').pop().toLowerCase();
      const mimeMap = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif', svg:'image/svg+xml', avif:'image/avif' };
      if (!headers.get('content-type') || headers.get('content-type') === 'application/octet-stream') {
        headers.set('content-type', mimeMap[ext] || 'image/jpeg');
      }
      headers.set('cache-control', 'public, max-age=604800, immutable');
      headers.set('access-control-allow-origin', '*');
      headers.set('vary', 'Accept');

      // 尝试使用 Images Binding 进行实时变换（免费计划可用）
      const accept = request.headers.get('accept') || '';
      let targetFormat = fmt;
      if (fmt === 'auto') {
        if (accept.includes('image/avif')) targetFormat = 'avif';
        else if (accept.includes('image/webp')) targetFormat = 'webp';
        else targetFormat = 'origin';
      }

      const needTransform = width > 0 || targetFormat !== 'origin';

      if (needTransform && env.IMAGES) {
        try {
          const imageStream = obj.body;
          const transforms = [];
          if (width > 0) transforms.push({ width });
          if (targetFormat === 'webp') transforms.push({ format: 'image/webp' });
          else if (targetFormat === 'avif') transforms.push({ format: 'image/avif' });

          const result = await env.IMAGES.input(imageStream)
            .transform(...transforms)
            .output({ quality });

          const outHeaders = new Headers();
          outHeaders.set('content-type', targetFormat === 'webp' ? 'image/webp' : targetFormat === 'avif' ? 'image/avif' : (mimeMap[ext] || 'image/jpeg'));
          outHeaders.set('cache-control', 'public, max-age=604800, immutable');
          outHeaders.set('access-control-allow-origin', '*');
          outHeaders.set('vary', 'Accept');

          const resp = new Response(result.body, { headers: outHeaders });
          await cache.put(cacheKey, resp.clone());
          return resp;
        } catch (e) {
          // Images Binding 不可用或变换失败，降级
        }
      }

      // 降级：返回原图
      headers.set('etag', obj.httpEtag);
      const fallback = new Response(obj.body, { headers });
      await cache.put(cacheKey, fallback.clone());
      return fallback;
    }

    try {
      // ─── 健康检查 ───
      if (pathname === '/api/health' && method === 'GET') {
        return json({ status: 'ok', time: new Date().toISOString() }, corsHeaders);
      }

      // ─── API 边缘缓存层（公开 GET 接口，数据变化频率低）───
      const apiCacheTTL = {
        '/api/settings': 300,    // 5 分钟
        '/api/categories': 300,  // 5 分钟
        '/api/works': 60,        // 1 分钟
        '/api/banners': 120,     // 2 分钟
        '/api/testimonials': 300 // 5 分钟
      };
      if (method === 'GET' && apiCacheTTL[pathname] && !pathname.includes('/api/works/')) {
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), request);
        const cached = await cache.match(cacheKey);
        if (cached) return cached;
        // 标记需要缓存（在 return 前写入）
        request._apiCacheKey = cacheKey;
        request._apiCacheTTL = apiCacheTTL[pathname];
      }

      // ═══════════════════════════════════════════
      // ─── 认证 (Auth) ───
      // ═══════════════════════════════════════════

      // ─── 登录 ───
      if (pathname === '/api/auth/login' && method === 'POST') {
        const body = await request.json();
        const username = (body.username || '').trim();
        const password = (body.password || '').trim();

        const adminUser = env.ADMIN_USER || 'admin';
        const adminPass = env.ADMIN_PASS || 'admin123';

        // 先检查 users 表（包括管理员和普通用户）
        const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
        if (user && await verifyPassword(password, user.password_hash)) {
          const role = (username === adminUser) ? 'admin' : 'user';
          const token = await generateToken(env, role, user.id, user.username);
          return json({ success: true, token, role, username: user.username }, corsHeaders);
        }

        // fallback 到 env 管理员凭据
        if (username === adminUser && password === adminPass) {
          const token = await generateToken(env, 'admin');
          return json({ success: true, token, role: 'admin' }, corsHeaders);
        }

        return json({ error: '用户名或密码错误' }, corsHeaders, 401);
      }

      // ─── 用户注册 ───
      if (pathname === '/api/auth/register' && method === 'POST') {
        const body = await request.json();
        const username = (body.username || '').trim();
        const password = (body.password || '').trim();

        if (!username || username.length < 2 || username.length > 30) {
          return json({ error: '用户名需要 2-30 个字符' }, corsHeaders, 400);
        }
        if (!password || password.length < 6) {
          return json({ error: '密码至少需要 6 个字符' }, corsHeaders, 400);
        }

        const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
        if (existing) {
          return json({ error: '该用户名已被注册' }, corsHeaders, 409);
        }

        const id = crypto.randomUUID();
        const hash = await hashPassword(password);
        await env.DB.prepare(
          'INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)'
        ).bind(id, username, hash).run();

        const token = await generateToken(env, 'user', id, username);
        return json({ success: true, token, role: 'user', username }, corsHeaders, 201);
      }

      // ─── 验证 token ───
      if (pathname === '/api/auth/verify' && method === 'GET') {
        const auth = request.headers.get('Authorization') || '';
        const payload = await verifyAuthPayload(auth, env);
        if (!payload) return json({ error: 'Unauthorized' }, corsHeaders, 401);
        return json({ success: true, role: payload.role, username: payload.username || 'admin' }, corsHeaders);
      }

      // ─── 修改密码 ───
      if (pathname === '/api/auth/change-password' && method === 'POST') {
        const authHeader = request.headers.get('Authorization') || '';
        const payload = await verifyAuthPayload(authHeader, env);
        if (!payload) return json({ error: 'Unauthorized' }, corsHeaders, 401);

        const body = await request.json();
        const oldPassword = (body.oldPassword || '').trim();
        const newPassword = (body.newPassword || '').trim();

        if (!oldPassword || !newPassword) {
          return json({ error: '请填写旧密码和新密码' }, corsHeaders, 400);
        }
        if (newPassword.length < 6) {
          return json({ error: '新密码至少需要 6 个字符' }, corsHeaders, 400);
        }

        const userId = payload.userId;
        if (!userId) {
          return json({ error: '管理员请先注册同名用户后再修改密码' }, corsHeaders, 400);
        }

        const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
        if (!user) return json({ error: '用户不存在' }, corsHeaders, 404);

        const valid = await verifyPassword(oldPassword, user.password_hash);
        if (!valid) return json({ error: '旧密码错误' }, corsHeaders, 401);

        const newHash = await hashPassword(newPassword);
        await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(newHash, userId).run();

        return json({ success: true, message: '密码修改成功' }, corsHeaders);
      }

      // ═══════════════════════════════════════════
      // ─── 公开 API (无需认证) ───
      // ═══════════════════════════════════════════

      // ─── 分类管理 (公开) ───
      if (pathname === '/api/categories' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM categories ORDER BY sort_order ASC, created_at ASC'
        ).all();
        return cachedJson(results, corsHeaders, request);
      }

      if (pathname.match(/^\/api\/categories\/([^/]+)$/) && method === 'GET') {
        const id = pathname.match(/^\/api\/categories\/([^/]+)$/)[1];
        const row = await env.DB.prepare('SELECT * FROM categories WHERE id = ?').bind(id).first();
        if (!row) return json({ error: 'Not found' }, corsHeaders, 404);
        return json(row, corsHeaders);
      }

      // ─── 获取所有作品 ───
      if (pathname === '/api/works' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM works ORDER BY sort_order ASC, created_at ASC'
        ).all();
        return cachedJson(results, corsHeaders, request);
      }

      // ─── 获取单个作品 ───
      const singleMatch = pathname.match(/^\/api\/works\/([^/]+)$/);
      if (singleMatch && method === 'GET') {
        const id = singleMatch[1];
        const row = await env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(id).first();
        if (!row) return json({ error: 'Not found' }, corsHeaders, 404);
        return json(row, corsHeaders);
      }

      // ─── 图片代理 ───
      const imageMatch = pathname.match(/^\/api\/image\/(.+)$/);
      if (imageMatch && method === 'GET') {
        const key = decodeURIComponent(imageMatch[1]);
        const obj = await env.R2.get(key);
        if (!obj) return json({ error: 'Image not found' }, corsHeaders, 404);
        const headers = new Headers(corsHeaders);
        obj.writeHttpMetadata(headers);
        // 如果缺少 content-type，根据扩展名推断
        if (!headers.get('content-type') || headers.get('content-type') === 'application/octet-stream') {
          const ext = key.split('.').pop().toLowerCase();
          const mimeMap = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif', svg:'image/svg+xml', avif:'image/avif' };
          headers.set('content-type', mimeMap[ext] || 'image/jpeg');
        }
        headers.set('etag', obj.httpEtag);
        headers.set('cache-control', 'public, max-age=604800, immutable');
        return new Response(obj.body, { headers });
      }

      // ─── 轮播图 (公开) ───
      if (pathname === '/api/banners' && method === 'GET') {
        const activeOnly = url.searchParams.get('active');
        let query = 'SELECT * FROM banners';
        if (activeOnly === '1') query += ' WHERE active = 1';
        query += ' ORDER BY sort_order ASC, created_at ASC';
        const { results } = await env.DB.prepare(query).all();
        return cachedJson(results, corsHeaders, request);
      }

      if (pathname.match(/^\/api\/banners\/([^/]+)$/) && method === 'GET') {
        const id = pathname.match(/^\/api\/banners\/([^/]+)$/)[1];
        const row = await env.DB.prepare('SELECT * FROM banners WHERE id = ?').bind(id).first();
        if (!row) return json({ error: 'Not found' }, corsHeaders, 404);
        return json(row, corsHeaders);
      }

      // ─── 客户心声 (公开) ───
      if (pathname === '/api/testimonials' && method === 'GET') {
        const activeOnly = url.searchParams.get('active');
        let query = 'SELECT * FROM testimonials';
        if (activeOnly === '1') query += ' WHERE active = 1';
        query += ' ORDER BY sort_order ASC, created_at ASC';
        const { results } = await env.DB.prepare(query).all();
        return cachedJson(results, corsHeaders, request);
      }

      // ─── 获取设置 (公开) ───
      if (pathname === '/api/settings' && method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM settings').all();
        const map = {};
        results.forEach(r => { map[r.key] = r.value; });
        return cachedJson(map, corsHeaders, request);
      }

      // ─── 提交建议（前台，无需登录）───
      if (pathname === '/api/suggestions' && method === 'POST') {
        const body = await request.json();
        const contact = (body.contact || '').trim().slice(0, 200);
        const content = (body.content || '').trim().slice(0, 5000);
        if (!content) return json({ error: '建议内容不能为空' }, corsHeaders, 400);
        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO suggestions (id, contact, content) VALUES (?, ?, ?)'
        ).bind(id, contact, content).run();
        return json({ success: true, id }, corsHeaders, 201);
      }

      // ─── 提交预约（前台，需要登录）───
      if (pathname === '/api/bookings' && method === 'POST') {
        const auth = request.headers.get('Authorization') || '';
        const valid = await verifyAuth(auth, env);
        if (!valid) return json({ error: '请先登录后再提交预约', needLogin: true }, corsHeaders, 401);

        const body = await request.json();
        const name = (body.name || '').trim().slice(0, 100);
        const phone = (body.phone || '').trim().slice(0, 30);
        const date = (body.date || '').trim().slice(0, 50);
        const type = (body.type || '').trim().slice(0, 100);
        const message = (body.message || '').trim().slice(0, 2000);
        if (!name || !phone) return json({ error: '姓名和联系电话为必填' }, corsHeaders, 400);

        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO bookings (id, name, phone, date, type, message) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, name, phone, date, type, message).run();
        return json({ success: true, id }, corsHeaders, 201);
      }

      // ═══════════════════════════════════════════
      // ─── 管理 API (需要认证) ───
      // ═══════════════════════════════════════════

      const auth = request.headers.get('Authorization') || '';
      const isAdmin = await verifyAuth(auth, env);

      if (!isAdmin) {
        return json({ error: 'Unauthorized', needLogin: true }, corsHeaders, 401);
      }

      // ─── 分类 CRUD (管理) ───
      if (pathname === '/api/categories' && method === 'POST') {
        const formData = await request.formData();
        const name = formData.get('name') || '';
        const slug = (formData.get('slug') || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const description = formData.get('description') || '';
        const sortOrder = parseInt(formData.get('sort_order') || '0', 10);

        if (!name.trim()) return json({ error: '分类名称不能为空' }, corsHeaders, 400);
        if (!slug) return json({ error: '分类标识不能为空' }, corsHeaders, 400);

        const existing = await env.DB.prepare('SELECT id FROM categories WHERE slug = ?').bind(slug).first();
        if (existing) return json({ error: '该标识已被使用' }, corsHeaders, 409);

        let imageKey = '';
        const file = formData.get('image');
        if (file && typeof file !== 'string') {
          const ext = file.name.split('.').pop() || 'jpg';
          imageKey = `categories/${crypto.randomUUID()}.${ext}`;
          await env.R2.put(imageKey, file.stream(), { httpMetadata: { contentType: file.type } });
        }

        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO categories (id, name, slug, description, image_key, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, name.trim(), slug, description.trim(), imageKey, sortOrder).run();

        const row = await env.DB.prepare('SELECT * FROM categories WHERE id = ?').bind(id).first();
        return json(row, corsHeaders, 201);
      }

      const catUpdateMatch = pathname.match(/^\/api\/categories\/([^/]+)$/);
      if (catUpdateMatch && method === 'PUT') {
        const id = catUpdateMatch[1];
        const existing = await env.DB.prepare('SELECT * FROM categories WHERE id = ?').bind(id).first();
        if (!existing) return json({ error: 'Not found' }, corsHeaders, 404);

        const formData = await request.formData();
        const name = formData.get('name') ?? existing.name;
        const slugRaw = (formData.get('slug') || '').trim();
        const slug = slugRaw ? slugRaw.toLowerCase().replace(/[^a-z0-9_-]/g, '-') : existing.slug;
        const description = formData.get('description') ?? existing.description;
        const sortOrder = formData.get('sort_order') != null
          ? parseInt(formData.get('sort_order'), 10) : existing.sort_order;

        if (slug !== existing.slug) {
          const dup = await env.DB.prepare('SELECT id FROM categories WHERE slug = ? AND id != ?').bind(slug, id).first();
          if (dup) return json({ error: '该标识已被使用' }, corsHeaders, 409);
        }

        let imageKey = existing.image_key;
        const file = formData.get('image');
        if (file && typeof file !== 'string') {
          if (imageKey) await env.R2.delete(imageKey);
          const ext = file.name.split('.').pop() || 'jpg';
          imageKey = `categories/${crypto.randomUUID()}.${ext}`;
          await env.R2.put(imageKey, file.stream(), { httpMetadata: { contentType: file.type } });
        }
        if (formData.get('remove_image') === '1' && imageKey) {
          await env.R2.delete(imageKey);
          imageKey = '';
        }

        await env.DB.prepare(
          'UPDATE categories SET name=?, slug=?, description=?, image_key=?, sort_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
        ).bind(name.trim(), slug, description.trim(), imageKey, sortOrder, id).run();

        const row = await env.DB.prepare('SELECT * FROM categories WHERE id = ?').bind(id).first();
        return json(row, corsHeaders);
      }

      if (catUpdateMatch && method === 'DELETE') {
        const id = catUpdateMatch[1];
        const existing = await env.DB.prepare('SELECT * FROM categories WHERE id = ?').bind(id).first();
        if (!existing) return json({ error: 'Not found' }, corsHeaders, 404);

        // 检查是否有作品使用此分类
        const usedWorks = await env.DB.prepare('SELECT COUNT(*) as cnt FROM works WHERE category = ?').bind(existing.slug).first();
        if (usedWorks && usedWorks.cnt > 0) {
          return json({ error: `该分类下还有 ${usedWorks.cnt} 个作品，请先删除或移动这些作品` }, corsHeaders, 400);
        }

        if (existing.image_key) await env.R2.delete(existing.image_key);
        await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
        return json({ success: true }, corsHeaders);
      }

      // ─── 作品 CRUD (管理) ───
      if (pathname === '/api/works' && method === 'POST') {
        const formData = await request.formData();
        const name = formData.get('name') || '';
        const cn = formData.get('cn') || '';
        const category = formData.get('category') || 'corporate';
        const detail = formData.get('detail') || '';
        const sortOrder = parseInt(formData.get('sort_order') || '0', 10);
        const file = formData.get('image');
        if (!file || typeof file === 'string') return json({ error: 'Image file is required' }, corsHeaders, 400);

        const ext = file.name.split('.').pop() || 'jpg';
        const key = `works/${crypto.randomUUID()}.${ext}`;
        await env.R2.put(key, file.stream(), { httpMetadata: { contentType: file.type } });

        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO works (id, name, cn, category, detail, image_key, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, name, cn, category, detail, key, sortOrder).run();

        const row = await env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(id).first();
        return json(row, corsHeaders, 201);
      }

      const updateWorkMatch = pathname.match(/^\/api\/works\/([^/]+)$/);
      if (updateWorkMatch && method === 'PUT') {
        const id = updateWorkMatch[1];
        const existing = await env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(id).first();
        if (!existing) return json({ error: 'Not found' }, corsHeaders, 404);

        const formData = await request.formData();
        const name = formData.get('name') ?? existing.name;
        const cn = formData.get('cn') ?? existing.cn;
        const category = formData.get('category') ?? existing.category;
        const detail = formData.get('detail') ?? existing.detail;
        const sortOrder = formData.get('sort_order') != null
          ? parseInt(formData.get('sort_order'), 10) : existing.sort_order;

        let imageKey = existing.image_key;
        const file = formData.get('image');
        if (file && typeof file !== 'string') {
          if (imageKey) await env.R2.delete(imageKey);
          const ext = file.name.split('.').pop() || 'jpg';
          imageKey = `works/${crypto.randomUUID()}.${ext}`;
          await env.R2.put(imageKey, file.stream(), { httpMetadata: { contentType: file.type } });
        }

        await env.DB.prepare(
          'UPDATE works SET name=?, cn=?, category=?, detail=?, image_key=?, sort_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
        ).bind(name, cn, category, detail, imageKey, sortOrder, id).run();

        const row = await env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(id).first();
        return json(row, corsHeaders);
      }

      if (updateWorkMatch && method === 'DELETE') {
        const id = updateWorkMatch[1];
        const existing = await env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(id).first();
        if (!existing) return json({ error: 'Not found' }, corsHeaders, 404);
        if (existing.image_key) await env.R2.delete(existing.image_key);
        await env.DB.prepare('DELETE FROM works WHERE id = ?').bind(id).run();
        return json({ success: true }, corsHeaders);
      }

      // ─── 轮播图 CRUD (管理) ───
      if (pathname === '/api/banners' && method === 'POST') {
        const formData = await request.formData();
        const title = formData.get('title') || '';
        const subtitle = formData.get('subtitle') || '';
        const link = formData.get('link') || '';
        const sortOrder = parseInt(formData.get('sort_order') || '0', 10);
        const active = formData.get('active') != null ? parseInt(formData.get('active'), 10) : 1;
        const file = formData.get('image');
        if (!file || typeof file === 'string') return json({ error: 'Image file is required' }, corsHeaders, 400);

        const ext = file.name.split('.').pop() || 'jpg';
        const key = `banners/${crypto.randomUUID()}.${ext}`;
        await env.R2.put(key, file.stream(), { httpMetadata: { contentType: file.type } });

        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO banners (id, title, subtitle, image_key, link, sort_order, active) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, title, subtitle, key, link, sortOrder, active).run();

        const row = await env.DB.prepare('SELECT * FROM banners WHERE id = ?').bind(id).first();
        return json(row, corsHeaders, 201);
      }

      const bannerUpdateMatch = pathname.match(/^\/api\/banners\/([^/]+)$/);
      if (bannerUpdateMatch && method === 'PUT') {
        const id = bannerUpdateMatch[1];
        const existing = await env.DB.prepare('SELECT * FROM banners WHERE id = ?').bind(id).first();
        if (!existing) return json({ error: 'Not found' }, corsHeaders, 404);

        const formData = await request.formData();
        const title = formData.get('title') ?? existing.title;
        const subtitle = formData.get('subtitle') ?? existing.subtitle;
        const link = formData.get('link') ?? existing.link;
        const sortOrder = formData.get('sort_order') != null
          ? parseInt(formData.get('sort_order'), 10) : existing.sort_order;
        const active = formData.get('active') != null
          ? parseInt(formData.get('active'), 10) : existing.active;

        let imageKey = existing.image_key;
        const file = formData.get('image');
        if (file && typeof file !== 'string') {
          if (imageKey) await env.R2.delete(imageKey);
          const ext = file.name.split('.').pop() || 'jpg';
          imageKey = `banners/${crypto.randomUUID()}.${ext}`;
          await env.R2.put(imageKey, file.stream(), { httpMetadata: { contentType: file.type } });
        }

        await env.DB.prepare(
          'UPDATE banners SET title=?, subtitle=?, image_key=?, link=?, sort_order=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
        ).bind(title, subtitle, imageKey, link, sortOrder, active, id).run();

        const row = await env.DB.prepare('SELECT * FROM banners WHERE id = ?').bind(id).first();
        return json(row, corsHeaders);
      }

      if (bannerUpdateMatch && method === 'DELETE') {
        const id = bannerUpdateMatch[1];
        const existing = await env.DB.prepare('SELECT * FROM banners WHERE id = ?').bind(id).first();
        if (!existing) return json({ error: 'Not found' }, corsHeaders, 404);
        if (existing.image_key) await env.R2.delete(existing.image_key);
        await env.DB.prepare('DELETE FROM banners WHERE id = ?').bind(id).run();
        return json({ success: true }, corsHeaders);
      }

      // ─── 预约管理 (后台) ───
      if (pathname === '/api/bookings' && method === 'GET') {
        const status = url.searchParams.get('status');
        let query = 'SELECT * FROM bookings';
        const params = [];
        if (status) { query += ' WHERE status = ?'; params.push(status); }
        query += ' ORDER BY created_at DESC';
        const stmt = params.length ? env.DB.prepare(query).bind(...params) : env.DB.prepare(query);
        const { results } = await stmt.all();
        return json(results, corsHeaders);
      }

      const bookingUpdateMatch = pathname.match(/^\/api\/bookings\/([^/]+)$/);
      if (bookingUpdateMatch && method === 'PUT') {
        const id = bookingUpdateMatch[1];
        const existing = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
        if (!existing) return json({ error: 'Not found' }, corsHeaders, 404);
        const body = await request.json();
        const status = body.status || existing.status;
        await env.DB.prepare('UPDATE bookings SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(status, id).run();
        const row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
        return json(row, corsHeaders);
      }

      if (bookingUpdateMatch && method === 'DELETE') {
        const id = bookingUpdateMatch[1];
        await env.DB.prepare('DELETE FROM bookings WHERE id = ?').bind(id).run();
        return json({ success: true }, corsHeaders);
      }

      // ─── 建议管理 (后台) ───
      if (pathname === '/api/suggestions' && method === 'GET') {
        const status = url.searchParams.get('status');
        let query = 'SELECT * FROM suggestions';
        const params = [];
        if (status) { query += ' WHERE status = ?'; params.push(status); }
        query += ' ORDER BY created_at DESC';
        const stmt = params.length ? env.DB.prepare(query).bind(...params) : env.DB.prepare(query);
        const { results } = await stmt.all();
        return json(results, corsHeaders);
      }

      const suggestionUpdateMatch = pathname.match(/^\/api\/suggestions\/([^/]+)$/);
      if (suggestionUpdateMatch && method === 'PUT') {
        const id = suggestionUpdateMatch[1];
        const existing = await env.DB.prepare('SELECT * FROM suggestions WHERE id = ?').bind(id).first();
        if (!existing) return json({ error: 'Not found' }, corsHeaders, 404);
        const body = await request.json();
        const status = body.status || existing.status;
        await env.DB.prepare('UPDATE suggestions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(status, id).run();
        const row = await env.DB.prepare('SELECT * FROM suggestions WHERE id = ?').bind(id).first();
        return json(row, corsHeaders);
      }

      if (suggestionUpdateMatch && method === 'DELETE') {
        const id = suggestionUpdateMatch[1];
        await env.DB.prepare('DELETE FROM suggestions WHERE id = ?').bind(id).run();
        return json({ success: true }, corsHeaders);
      }

      // ─── 更新设置 (管理) ───
      if (pathname === '/api/settings' && method === 'PUT') {
        const body = await request.json();
        for (const [key, value] of Object.entries(body)) {
          await env.DB.prepare(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=?, updated_at=CURRENT_TIMESTAMP'
          ).bind(key, value, value).run();
        }
        const { results } = await env.DB.prepare('SELECT * FROM settings').all();
        const map = {};
        results.forEach(r => { map[r.key] = r.value; });
        return json(map, corsHeaders);
      }

      // ─── 通用图片上传 (管理) ───
      if (pathname === '/api/upload-image' && method === 'POST') {
        const formData = await request.formData();
        const file = formData.get('image');
        if (!file || typeof file === 'string') return json({ error: 'Image file is required' }, corsHeaders, 400);

        const ext = file.name.split('.').pop() || 'jpg';
        const folder = formData.get('folder') || 'settings';
        const key = `${folder}/${crypto.randomUUID()}.${ext}`;
        await env.R2.put(key, file.stream(), { httpMetadata: { contentType: file.type } });

        return json({ success: true, key }, corsHeaders, 201);
      }

      // ─── 客户心声 CRUD (管理) ───
      if (pathname === '/api/testimonials' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM testimonials ORDER BY sort_order ASC, created_at ASC'
        ).all();
        return json(results, corsHeaders);
      }

      if (pathname === '/api/testimonials' && method === 'POST') {
        const formData = await request.formData();
        const quote = formData.get('quote') || '';
        const author = formData.get('author') || '';
        const detail = formData.get('detail') || '';
        const stars = parseInt(formData.get('stars') || '5', 10);
        const sortOrder = parseInt(formData.get('sort_order') || '0', 10);
        const active = formData.get('active') != null ? parseInt(formData.get('active'), 10) : 1;

        let bgKey = '';
        const file = formData.get('bg_image');
        if (file && typeof file !== 'string') {
          const ext = file.name.split('.').pop() || 'jpg';
          bgKey = `testimonials/${crypto.randomUUID()}.${ext}`;
          await env.R2.put(bgKey, file.stream(), { httpMetadata: { contentType: file.type } });
        }

        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO testimonials (id, quote, author, detail, stars, bg_key, sort_order, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, quote, author, detail, stars, bgKey, sortOrder, active).run();

        const row = await env.DB.prepare('SELECT * FROM testimonials WHERE id = ?').bind(id).first();
        return json(row, corsHeaders, 201);
      }

      const testimonialUpdateMatch = pathname.match(/^\/api\/testimonials\/([^/]+)$/);
      if (testimonialUpdateMatch && method === 'PUT') {
        const id = testimonialUpdateMatch[1];
        const existing = await env.DB.prepare('SELECT * FROM testimonials WHERE id = ?').bind(id).first();
        if (!existing) return json({ error: 'Not found' }, corsHeaders, 404);

        const formData = await request.formData();
        const quote = formData.get('quote') ?? existing.quote;
        const author = formData.get('author') ?? existing.author;
        const detail = formData.get('detail') ?? existing.detail;
        const stars = formData.get('stars') != null ? parseInt(formData.get('stars'), 10) : existing.stars;
        const sortOrder = formData.get('sort_order') != null ? parseInt(formData.get('sort_order'), 10) : existing.sort_order;
        const active = formData.get('active') != null ? parseInt(formData.get('active'), 10) : existing.active;

        let bgKey = existing.bg_key;
        const file = formData.get('bg_image');
        if (file && typeof file !== 'string') {
          if (bgKey) await env.R2.delete(bgKey);
          const ext = file.name.split('.').pop() || 'jpg';
          bgKey = `testimonials/${crypto.randomUUID()}.${ext}`;
          await env.R2.put(bgKey, file.stream(), { httpMetadata: { contentType: file.type } });
        }
        // Check if bg_image removal was requested
        if (formData.get('remove_bg') === '1' && bgKey) {
          await env.R2.delete(bgKey);
          bgKey = '';
        }

        await env.DB.prepare(
          'UPDATE testimonials SET quote=?, author=?, detail=?, stars=?, bg_key=?, sort_order=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
        ).bind(quote, author, detail, stars, bgKey, sortOrder, active, id).run();

        const row = await env.DB.prepare('SELECT * FROM testimonials WHERE id = ?').bind(id).first();
        return json(row, corsHeaders);
      }

      if (testimonialUpdateMatch && method === 'DELETE') {
        const id = testimonialUpdateMatch[1];
        const existing = await env.DB.prepare('SELECT * FROM testimonials WHERE id = ?').bind(id).first();
        if (!existing) return json({ error: 'Not found' }, corsHeaders, 404);
        if (existing.bg_key) await env.R2.delete(existing.bg_key);
        await env.DB.prepare('DELETE FROM testimonials WHERE id = ?').bind(id).run();
        return json({ success: true }, corsHeaders);
      }

      return json({ error: 'Not found' }, corsHeaders, 404);
    } catch (err) {
      return json({ error: err.message }, corsHeaders, 500);
    }
  }
};

// ═══════════════════════════════════════════
// ─── 认证工具函数 ───
// ═══════════════════════════════════════════

async function generateToken(env, role = 'admin', userId = null, username = null) {
  const secret = env.JWT_SECRET || 'bailuyuan-admin-secret-2026';
  const payload = { role, userId, username, iat: Date.now(), exp: Date.now() + 7 * 24 * 3600 * 1000 };
  const data = JSON.stringify(payload);
  const encoded = btoa(unescape(encodeURIComponent(data)));
  const sig = await hmacSign(encoded, secret);
  return `${encoded}.${sig}`;
}

async function verifyAuthPayload(authHeader, env) {
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const secret = env.JWT_SECRET || 'bailuyuan-admin-secret-2026';
  const expectedSig = await hmacSign(encoded, secret);
  if (sig !== expectedSig) return null;
  try {
    const payload = JSON.parse(decodeURIComponent(escape(atob(encoded))));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

async function verifyAuth(authHeader, env) {
  const payload = await verifyAuthPayload(authHeader, env);
  return payload && (payload.role === 'admin' || payload.role === 'user');
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = [...salt].map(b => b.toString(16).padStart(2, '0')).join('');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256
  );
  const hashHex = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${saltHex}:${hashHex}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256
  );
  const computed = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return computed === hashHex;
}

async function hmacSign(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function json(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// 带边缘缓存的 JSON 响应
async function cachedJson(data, corsHeaders, request, status = 200) {
  const resp = new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
  if (request._apiCacheKey) {
    const ttl = request._apiCacheTTL || 60;
    const toCache = new Response(resp.body, resp);
    toCache.headers.set('cache-control', `public, max-age=${ttl}, stale-while-revalidate=${ttl * 2}`);
    try { await caches.default.put(request._apiCacheKey, toCache.clone()); } catch (e) {}
    return toCache;
  }
  return resp;
}
