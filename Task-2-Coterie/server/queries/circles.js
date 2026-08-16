// The circle query and its mapper.
//
// Positional contract: $1 is the id of the person looking, so a WHERE clause
// appended to this fragment starts at $2. See server/queries/posts.js.

const CIRCLE_SELECT = `
  SELECT c.id, c.slug, c.name, c.description,
         (SELECT count(*) FROM memberships m WHERE m.circle_id = c.id) AS member_count,
         (SELECT count(*) FROM posts p WHERE p.circle_id = c.id) AS post_count,
         EXISTS (SELECT 1 FROM memberships m
                 WHERE m.circle_id = c.id AND m.user_id = $1) AS joined
  FROM circles c
`;

function toCircle(row) {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    memberCount: Number(row.member_count),
    postCount: Number(row.post_count),
    joined: row.joined,
  };
}

module.exports = { CIRCLE_SELECT, toCircle };
