// The profile query and its mapper.
//
// Positional contract: $1 is the id of the person looking, so a WHERE clause
// appended to this fragment starts at $2. See server/queries/posts.js.

const PROFILE_SELECT = `
  SELECT u.id, u.handle, u.display_name, u.bio, u.created_at,
         (SELECT count(*) FROM follows f WHERE f.followee_id = u.id) AS follower_count,
         (SELECT count(*) FROM follows f WHERE f.follower_id = u.id) AS following_count,
         (SELECT count(*) FROM posts   p WHERE p.author_id  = u.id) AS post_count,
         EXISTS (SELECT 1 FROM follows f
                 WHERE f.follower_id = $1 AND f.followee_id = u.id) AS following
  FROM users u
`;

function toProfile(row, viewerId) {
  return {
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio,
    joined: row.created_at,
    followerCount: Number(row.follower_count),
    followingCount: Number(row.following_count),
    postCount: Number(row.post_count),
    following: row.following,
    isMe: row.id === viewerId,
  };
}

module.exports = { PROFILE_SELECT, toProfile };
