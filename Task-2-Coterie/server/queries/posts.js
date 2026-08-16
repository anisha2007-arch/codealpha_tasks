// The post listing query and its mapper.
//
// Three route modules need these — the feed, a circle's posts, and a person's
// posts — and one route module borrowing them from another made a route file
// into a dependency of two other route files. They live here instead.
//
// Positional contract: $1 is the id of the person looking. Every fragment in
// server/queries/ takes the viewer as $1 so they can be concatenated with a
// WHERE clause that starts at $2. A caller whose only parameter happens to be
// the viewer still has to pass it as $1.

const POST_SELECT = `
  SELECT p.id, p.body, p.created_at,
         u.handle, u.display_name,
         c.slug AS circle_slug, c.name AS circle_name,
         (SELECT count(*) FROM likes    l WHERE l.post_id = p.id) AS like_count,
         (SELECT count(*) FROM comments m WHERE m.post_id = p.id) AS comment_count,
         EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked,
         p.author_id
  FROM posts p
  JOIN users u ON u.id = p.author_id
  LEFT JOIN circles c ON c.id = p.circle_id
`;

function toPost(row, viewerId) {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    author: { handle: row.handle, displayName: row.display_name },
    circle: row.circle_slug ? { slug: row.circle_slug, name: row.circle_name } : null,
    likeCount: Number(row.like_count),
    commentCount: Number(row.comment_count),
    liked: row.liked,
    mine: row.author_id === viewerId,
  };
}

module.exports = { POST_SELECT, toPost };
