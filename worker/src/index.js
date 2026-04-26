export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // ─── 健康检查 ───
      if (pathname === '/api/health' && method === 'GET') {
        return json({ status: 'ok', time: new Date().toISOString() }, corsHeaders);
      }

      // ─── 获取所有作品 ───
      if (pathname === '/api/works' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT * FROM works ORDER BY sort_order ASC, created_at ASC'
        ).all();
        return json(results, corsHeaders);
      }

      // ─── 获取单个作品 ───
      const singleMatch = pathname.match(/^\/api\/works\/([^/]+)$/);
      if (singleMatch && method === 'GET') {
        const id = singleMatch[1];
        const row = await env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(id).first();
        if (!row) return json({ error: 'Not found' }, corsHeaders, 404);
        return json(row, corsHeaders);
      }

      // ─── 创建作品 ───
      if (pathname === '/api/works' && method === 'POST') {
        const formData = await request.formData();
        const name = formData.get('name') || '';
        const cn = formData.get('cn') || '';
        const category = formData.get('category') || 'corporate';
        const detail = formData.get('detail') || '';
        const sortOrder = parseInt(formData.get('sort_order') || '0', 10);
        const file = formData.get('image');

        if (!file || typeof file === 'string') {
          return json({ error: 'Image file is required' }, corsHeaders, 400);
        }

        const ext = file.name.split('.').pop() || 'jpg';
        const key = `works/${crypto.randomUUID()}.${ext}`;

        await env.R2.put(key, file.stream(), {
          httpMetadata: { contentType: file.type },
        });

        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO works (id, name, cn, category, detail, image_key, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, name, cn, category, detail, key, sortOrder).run();

        const row = await env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(id).first();
        return json(row, corsHeaders, 201);
      }

      // ─── 更新作品 ───
      const updateMatch = pathname.match(/^\/api\/works\/([^/]+)$/);
      if (updateMatch && method === 'PUT') {
        const id = updateMatch[1];
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
          await env.R2.put(imageKey, file.stream(), {
            httpMetadata: { contentType: file.type },
          });
        }

        await env.DB.prepare(
          'UPDATE works SET name=?, cn=?, category=?, detail=?, image_key=?, sort_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
        ).bind(name, cn, category, detail, imageKey, sortOrder, id).run();

        const row = await env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(id).first();
        return json(row, corsHeaders);
      }

      // ─── 删除作品 ───
      const deleteMatch = pathname.match(/^\/api\/works\/([^/]+)$/);
      if (deleteMatch && method === 'DELETE') {
        const id = deleteMatch[1];
        const existing = await env.DB.prepare('SELECT * FROM works WHERE id = ?').bind(id).first();
        if (!existing) return json({ error: 'Not found' }, corsHeaders, 404);

        if (existing.image_key) await env.R2.delete(existing.image_key);
        await env.DB.prepare('DELETE FROM works WHERE id = ?').bind(id).run();

        return json({ success: true }, corsHeaders);
      }

      // ─── 图片代理 ───
      const imageMatch = pathname.match(/^\/api\/image\/(.+)$/);
      if (imageMatch && method === 'GET') {
        const key = decodeURIComponent(imageMatch[1]);
        const obj = await env.R2.get(key);
        if (!obj) return json({ error: 'Image not found' }, corsHeaders, 404);

        const headers = new Headers(corsHeaders);
        obj.writeHttpMetadata(headers);
        headers.set('etag', obj.httpEtag);
        headers.set('cache-control', 'public, max-age=86400');
        return new Response(obj.body, { headers });
      }

      // ═══════════════════════════════════════════
      // ─── 轮播图 (Banners) ───
      // ═══════════════════════════════════════════

      // ─── 获取所有轮播图 ───
      if (pathname === '/api/banners' && method === 'GET') {
        const activeOnly = url.searchParams.get('active');
        let query = 'SELECT * FROM banners';
        if (activeOnly === '1') query += ' WHERE active = 1';
        query += ' ORDER BY sort_order ASC, created_at ASC';
        const { results } = await env.DB.prepare(query).all();
        return json(results, corsHeaders);
      }

      // ─── 获取单个轮播图 ───
      const bannerSingleMatch = pathname.match(/^\/api\/banners\/([^/]+)$/);
      if (bannerSingleMatch && method === 'GET') {
        const id = bannerSingleMatch[1];
        const row = await env.DB.prepare('SELECT * FROM banners WHERE id = ?').bind(id).first();
        if (!row) return json({ error: 'Not found' }, corsHeaders, 404);
        return json(row, corsHeaders);
      }

      // ─── 创建轮播图 ───
      if (pathname === '/api/banners' && method === 'POST') {
        const formData = await request.formData();
        const title = formData.get('title') || '';
        const subtitle = formData.get('subtitle') || '';
        const link = formData.get('link') || '';
        const sortOrder = parseInt(formData.get('sort_order') || '0', 10);
        const active = formData.get('active') != null ? parseInt(formData.get('active'), 10) : 1;
        const file = formData.get('image');

        if (!file || typeof file === 'string') {
          return json({ error: 'Image file is required' }, corsHeaders, 400);
        }

        const ext = file.name.split('.').pop() || 'jpg';
        const key = `banners/${crypto.randomUUID()}.${ext}`;

        await env.R2.put(key, file.stream(), {
          httpMetadata: { contentType: file.type },
        });

        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO banners (id, title, subtitle, image_key, link, sort_order, active) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, title, subtitle, key, link, sortOrder, active).run();

        const row = await env.DB.prepare('SELECT * FROM banners WHERE id = ?').bind(id).first();
        return json(row, corsHeaders, 201);
      }

      // ─── 更新轮播图 ───
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
          await env.R2.put(imageKey, file.stream(), {
            httpMetadata: { contentType: file.type },
          });
        }

        await env.DB.prepare(
          'UPDATE banners SET title=?, subtitle=?, image_key=?, link=?, sort_order=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
        ).bind(title, subtitle, imageKey, link, sortOrder, active, id).run();

        const row = await env.DB.prepare('SELECT * FROM banners WHERE id = ?').bind(id).first();
        return json(row, corsHeaders);
      }

      // ─── 删除轮播图 ───
      const bannerDeleteMatch = pathname.match(/^\/api\/banners\/([^/]+)$/);
      if (bannerDeleteMatch && method === 'DELETE') {
        const id = bannerDeleteMatch[1];
        const existing = await env.DB.prepare('SELECT * FROM banners WHERE id = ?').bind(id).first();
        if (!existing) return json({ error: 'Not found' }, corsHeaders, 404);

        if (existing.image_key) await env.R2.delete(existing.image_key);
        await env.DB.prepare('DELETE FROM banners WHERE id = ?').bind(id).run();

        return json({ success: true }, corsHeaders);
      }

      // ═══════════════════════════════════════════
      // ─── 预约 (Bookings) ───
      // ═══════════════════════════════════════════

      // ─── 提交预约（前台） ───
      if (pathname === '/api/bookings' && method === 'POST') {
        const body = await request.json();
        const name = (body.name || '').trim().slice(0, 100);
        const phone = (body.phone || '').trim().slice(0, 30);
        const date = (body.date || '').trim().slice(0, 50);
        const type = (body.type || '').trim().slice(0, 100);
        const message = (body.message || '').trim().slice(0, 2000);

        if (!name || !phone) {
          return json({ error: '姓名和联系电话为必填' }, corsHeaders, 400);
        }

        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO bookings (id, name, phone, date, type, message) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(id, name, phone, date, type, message).run();

        return json({ success: true, id }, corsHeaders, 201);
      }

      // ─── 获取所有预约（后台） ───
      if (pathname === '/api/bookings' && method === 'GET') {
        const status = url.searchParams.get('status');
        let query = 'SELECT * FROM bookings';
        const params = [];
        if (status) {
          query += ' WHERE status = ?';
          params.push(status);
        }
        query += ' ORDER BY created_at DESC';
        const stmt = params.length
          ? env.DB.prepare(query).bind(...params)
          : env.DB.prepare(query);
        const { results } = await stmt.all();
        return json(results, corsHeaders);
      }

      // ─── 更新预约状态（后台） ───
      const bookingUpdateMatch = pathname.match(/^\/api\/bookings\/([^/]+)$/);
      if (bookingUpdateMatch && method === 'PUT') {
        const id = bookingUpdateMatch[1];
        const existing = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
        if (!existing) return json({ error: 'Not found' }, corsHeaders, 404);

        const body = await request.json();
        const status = body.status || existing.status;

        await env.DB.prepare(
          'UPDATE bookings SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
        ).bind(status, id).run();

        const row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
        return json(row, corsHeaders);
      }

      // ─── 删除预约（后台） ───
      const bookingDeleteMatch = pathname.match(/^\/api\/bookings\/([^/]+)$/);
      if (bookingDeleteMatch && method === 'DELETE') {
        const id = bookingDeleteMatch[1];
        await env.DB.prepare('DELETE FROM bookings WHERE id = ?').bind(id).run();
        return json({ success: true }, corsHeaders);
      }

      // ═══════════════════════════════════════════
      // ─── 建议 (Suggestions) ───
      // ═══════════════════════════════════════════

      // ─── 提交建议（前台） ───
      if (pathname === '/api/suggestions' && method === 'POST') {
        const body = await request.json();
        const contact = (body.contact || '').trim().slice(0, 200);
        const content = (body.content || '').trim().slice(0, 5000);

        if (!content) {
          return json({ error: '建议内容不能为空' }, corsHeaders, 400);
        }

        const id = crypto.randomUUID();
        await env.DB.prepare(
          'INSERT INTO suggestions (id, contact, content) VALUES (?, ?, ?)'
        ).bind(id, contact, content).run();

        return json({ success: true, id }, corsHeaders, 201);
      }

      // ─── 获取所有建议（后台） ───
      if (pathname === '/api/suggestions' && method === 'GET') {
        const status = url.searchParams.get('status');
        let query = 'SELECT * FROM suggestions';
        const params = [];
        if (status) {
          query += ' WHERE status = ?';
          params.push(status);
        }
        query += ' ORDER BY created_at DESC';
        const stmt = params.length
          ? env.DB.prepare(query).bind(...params)
          : env.DB.prepare(query);
        const { results } = await stmt.all();
        return json(results, corsHeaders);
      }

      // ─── 更新建议状态（后台） ───
      const suggestionUpdateMatch = pathname.match(/^\/api\/suggestions\/([^/]+)$/);
      if (suggestionUpdateMatch && method === 'PUT') {
        const id = suggestionUpdateMatch[1];
        const existing = await env.DB.prepare('SELECT * FROM suggestions WHERE id = ?').bind(id).first();
        if (!existing) return json({ error: 'Not found' }, corsHeaders, 404);

        const body = await request.json();
        const status = body.status || existing.status;

        await env.DB.prepare(
          'UPDATE suggestions SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
        ).bind(status, id).run();

        const row = await env.DB.prepare('SELECT * FROM suggestions WHERE id = ?').bind(id).first();
        return json(row, corsHeaders);
      }

      // ─── 删除建议（后台） ───
      const suggestionDeleteMatch = pathname.match(/^\/api\/suggestions\/([^/]+)$/);
      if (suggestionDeleteMatch && method === 'DELETE') {
        const id = suggestionDeleteMatch[1];
        await env.DB.prepare('DELETE FROM suggestions WHERE id = ?').bind(id).run();
        return json({ success: true }, corsHeaders);
      }

      // ═══════════════════════════════════════════
      // ─── 网站设置 (Settings) ───
      // ═══════════════════════════════════════════

      // ─── 获取所有设置（前台+后台） ───
      if (pathname === '/api/settings' && method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM settings').all();
        const map = {};
        results.forEach(r => { map[r.key] = r.value; });
        return json(map, corsHeaders);
      }

      // ─── 更新设置（后台） ───
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

      return json({ error: 'Not found' }, corsHeaders, 404);
    } catch (err) {
      return json({ error: err.message }, corsHeaders, 500);
    }
  }
};

function json(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
