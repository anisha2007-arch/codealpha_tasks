-- Runs on first container start and again on every boot; all statements are
-- idempotent, so an existing database is left alone.

CREATE TABLE IF NOT EXISTS books (
  id          SERIAL  PRIMARY KEY,
  slug        TEXT    NOT NULL UNIQUE,
  title       TEXT    NOT NULL,
  author      TEXT    NOT NULL,
  genre       TEXT    NOT NULL,
  price       NUMERIC NOT NULL,
  year        INTEGER NOT NULL,
  pages       INTEGER NOT NULL,
  blurb       TEXT    NOT NULL,
  stock       INTEGER NOT NULL DEFAULT 12,
  cover_image TEXT
);

-- Add cover_image to any existing books table that predates this column
ALTER TABLE books ADD COLUMN IF NOT EXISTS cover_image TEXT;

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT   NOT NULL,
  email         TEXT   NOT NULL UNIQUE,
  password_hash TEXT   NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id         SERIAL      PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id),
  items      JSONB       NOT NULL,
  subtotal   NUMERIC     NOT NULL,
  shipping   NUMERIC     NOT NULL,
  total      NUMERIC     NOT NULL,
  address    JSONB       NOT NULL,
  status     TEXT        NOT NULL DEFAULT 'Placed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders (user_id);

-- Seed cover images for existing rows (idempotent; URLs use loremflickr keyword search
-- so each image matches the book's theme; ?lock= pins the result to one stable photo)
UPDATE books SET cover_image = 'https://covers.openlibrary.org/b/isbn/9780679731726-L.jpg' WHERE slug = 'the-quiet-shelf';
UPDATE books SET cover_image = 'https://covers.openlibrary.org/b/isbn/9780441478125-L.jpg' WHERE slug = 'salt-and-signal';
UPDATE books SET cover_image = 'https://covers.openlibrary.org/b/isbn/9781984822185-L.jpg' WHERE slug = 'the-marginal-notes';
UPDATE books SET cover_image = 'https://covers.openlibrary.org/b/isbn/9780307588371-L.jpg' WHERE slug = 'gridlock';
UPDATE books SET cover_image = 'https://covers.openlibrary.org/b/isbn/9780062316097-L.jpg' WHERE slug = 'a-short-history-of-rain';
UPDATE books SET cover_image = 'https://covers.openlibrary.org/b/isbn/9780151446476-L.jpg' WHERE slug = 'the-cartographers-error';
UPDATE books SET cover_image = 'https://covers.openlibrary.org/b/isbn/9780395927205-L.jpg' WHERE slug = 'paper-lantern';
UPDATE books SET cover_image = 'https://covers.openlibrary.org/b/isbn/9780062073488-L.jpg' WHERE slug = 'the-tenth-floor';
UPDATE books SET cover_image = 'https://covers.openlibrary.org/b/isbn/9780142001615-L.jpg' WHERE slug = 'slow-fire';
UPDATE books SET cover_image = 'https://covers.openlibrary.org/b/isbn/9780385539258-L.jpg' WHERE slug = 'everything-in-transit';
UPDATE books SET cover_image = 'https://covers.openlibrary.org/b/isbn/9780441013593-L.jpg' WHERE slug = 'the-glass-orchard';
UPDATE books SET cover_image = 'https://covers.openlibrary.org/b/isbn/9781594634024-L.jpg' WHERE slug = 'undertow';

INSERT INTO books (slug, title, author, genre, price, year, pages, blurb, stock, cover_image) VALUES
('the-quiet-shelf', 'The Remains of the Day', 'Kazuo Ishiguro', 'Literary', 449, 1989, 288,
 'A butler reflects on his decades of devoted service to an English lord, slowly confronting the personal cost of a life lived entirely for duty.', 14,
 'https://covers.openlibrary.org/b/isbn/9780679731726-L.jpg'),
('salt-and-signal', 'The Left Hand of Darkness', 'Ursula K. Le Guin', 'Science Fiction', 399, 1969, 352,
 'A human envoy is sent to a genderless alien world on a political mission, and must navigate loyalty, betrayal, and what it means to be human.', 9,
 'https://covers.openlibrary.org/b/isbn/9780441478125-L.jpg'),
('the-marginal-notes', 'Normal People', 'Sally Rooney', 'Literary', 375, 2017, 244,
 'Two teenagers from the west of Ireland navigate a complicated, on-off relationship from secondary school through college and beyond.', 20,
 'https://covers.openlibrary.org/b/isbn/9781984822185-L.jpg'),
('gridlock', 'Gone Girl', 'Gillian Flynn', 'Thriller', 349, 2012, 400,
 'On their fifth wedding anniversary, Amy Dunne vanishes, and all evidence points to her charming husband Nick as the prime suspect.', 11,
 'https://covers.openlibrary.org/b/isbn/9780307588371-L.jpg'),
('a-short-history-of-rain', 'Sapiens', 'Yuval Noah Harari', 'Non-fiction', 525, 2014, 312,
 'A sweeping history of humankind from the Stone Age to the modern era, exploring how biology, culture, and ideas have shaped our species.', 7,
 'https://covers.openlibrary.org/b/isbn/9780062316097-L.jpg'),
('the-cartographers-error', 'The Name of the Rose', 'Umberto Eco', 'Historical', 475, 1980, 368,
 'A Franciscan friar investigates a series of mysterious deaths at a medieval Italian abbey, uncovering heresy, forbidden books, and dark secrets.', 6,
 'https://covers.openlibrary.org/b/isbn/9780151446476-L.jpg'),
('paper-lantern', 'Interpreter of Maladies', 'Jhumpa Lahiri', 'Literary', 299, 1999, 196,
 'Nine stories exploring the lives of Indian and Indian-American characters caught between cultures, navigating love, loss, and displacement.', 18,
 'https://covers.openlibrary.org/b/isbn/9780395927205-L.jpg'),
('the-tenth-floor', 'And Then There Were None', 'Agatha Christie', 'Mystery', 399, 1939, 336,
 'Ten strangers are lured to an isolated island and begin dying one by one — but there is no murderer among them, or so it seems.', 13,
 'https://covers.openlibrary.org/b/isbn/9780062073488-L.jpg'),
('slow-fire', 'Salt: A World History', 'Mark Kurlansky', 'Non-fiction', 550, 2016, 420,
 'The remarkable story of salt — the only rock humans eat — and how it has shaped civilisations, ignited wars, and driven economies across history.', 8,
 'https://covers.openlibrary.org/b/isbn/9780142001615-L.jpg'),
('everything-in-transit', 'A Little Life', 'Hanya Yanagihara', 'Literary', 425, 2015, 268,
 'Four college friends build their lives in New York City, but the novel centres on one deeply wounded man and the lasting weight of childhood trauma.', 15,
 'https://covers.openlibrary.org/b/isbn/9780385539258-L.jpg'),
('the-glass-orchard', 'Dune', 'Frank Herbert', 'Science Fiction', 465, 1965, 384,
 'A young nobleman is thrust into the brutal politics of a desert planet that produces the most valuable substance in the universe.', 10,
 'https://covers.openlibrary.org/b/isbn/9780441013593-L.jpg'),
('undertow', 'The Girl on the Train', 'Paula Hawkins', 'Thriller', 359, 2015, 328,
 'A woman who commutes past the same house every day witnesses something from the train window that pulls her into a chilling missing-persons case.', 12,
 'https://covers.openlibrary.org/b/isbn/9781594634024-L.jpg')
ON CONFLICT (slug) DO NOTHING;

-- Update titles and authors for existing rows (if DB was already seeded with old data)
UPDATE books SET title = 'The Remains of the Day',    author = 'Kazuo Ishiguro',    year = 1989, blurb = 'A butler reflects on his decades of devoted service to an English lord, slowly confronting the personal cost of a life lived entirely for duty.'                        WHERE slug = 'the-quiet-shelf';
UPDATE books SET title = 'The Left Hand of Darkness', author = 'Ursula K. Le Guin', year = 1969, blurb = 'A human envoy is sent to a genderless alien world on a political mission, and must navigate loyalty, betrayal, and what it means to be human.'                                WHERE slug = 'salt-and-signal';
UPDATE books SET title = 'Normal People',             author = 'Sally Rooney',       year = 2018, blurb = 'Two teenagers from the west of Ireland navigate a complicated, on-off relationship from secondary school through college and beyond.'                                          WHERE slug = 'the-marginal-notes';
UPDATE books SET title = 'Gone Girl',                 author = 'Gillian Flynn',      year = 2012, blurb = 'On their fifth wedding anniversary, Amy Dunne vanishes, and all evidence points to her charming husband Nick as the prime suspect.'                                             WHERE slug = 'gridlock';
UPDATE books SET title = 'Sapiens',                   author = 'Yuval Noah Harari',  year = 2014, blurb = 'A sweeping history of humankind from the Stone Age to the modern era, exploring how biology, culture, and ideas have shaped our species.'                                      WHERE slug = 'a-short-history-of-rain';
UPDATE books SET title = 'The Name of the Rose',      author = 'Umberto Eco',        year = 1980, blurb = 'A Franciscan friar investigates a series of mysterious deaths at a medieval Italian abbey, uncovering heresy, forbidden books, and dark secrets.'                              WHERE slug = 'the-cartographers-error';
UPDATE books SET title = 'Interpreter of Maladies',   author = 'Jhumpa Lahiri',      year = 1999, blurb = 'Nine stories exploring the lives of Indian and Indian-American characters caught between cultures, navigating love, loss, and displacement.'                                   WHERE slug = 'paper-lantern';
UPDATE books SET title = 'And Then There Were None',  author = 'Agatha Christie',    year = 1939, blurb = 'Ten strangers are lured to an isolated island and begin dying one by one — but there is no murderer among them, or so it seems.'                                               WHERE slug = 'the-tenth-floor';
UPDATE books SET title = 'Salt: A World History',     author = 'Mark Kurlansky',     year = 2002, blurb = 'The remarkable story of salt — the only rock humans eat — and how it has shaped civilisations, ignited wars, and driven economies across history.'                             WHERE slug = 'slow-fire';
UPDATE books SET title = 'A Little Life',             author = 'Hanya Yanagihara',   year = 2015, blurb = 'Four college friends build their lives in New York City, but the novel centres on one deeply wounded man and the lasting weight of childhood trauma.'                          WHERE slug = 'everything-in-transit';
UPDATE books SET title = 'Dune',                      author = 'Frank Herbert',       year = 1965, blurb = 'A young nobleman is thrust into the brutal politics of a desert planet that produces the most valuable substance in the universe.'                                             WHERE slug = 'the-glass-orchard';
UPDATE books SET title = 'The Girl on the Train',     author = 'Paula Hawkins',      year = 2015, blurb = 'A woman who commutes past the same house every day witnesses something from the train window that pulls her into a chilling missing-persons case.'                             WHERE slug = 'undertow';
UPDATE books SET title = 'The Girl on the Train',     author = 'Paula Hawkins',      blurb = 'A woman who commutes past the same house every day witnesses something from the train window that pulls her into a chilling missing-persons case.'                                                     WHERE slug = 'undertow';
