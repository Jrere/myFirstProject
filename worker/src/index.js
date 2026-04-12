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
