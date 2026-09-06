/**
 * Format signatures the pipeline treats as known from day one (A §8.1).
 *
 * A message whose `format_signature` has never been seen lands in the admin
 * "Needs attention" queue as `new_format` until someone confirms it. The six
 * real WhatsApp posts and the sample messages G-J are the formats the product
 * was built on, so they are seeded `known` and the demo queue shows only the
 * message that is meant to be there.
 *
 * `scripts/eval.ts` asserts that the six fixture messages still produce a
 * signature in this set, so a change to the classifier cannot silently turn
 * the demo corpus into a queue full of "new format".
 */
export const KNOWN_SIGNATURES: ReadonlySet<string> = new Set([
  // A — title state header, city headers, "ST ZIP CF" lines
  "H:CITY STNAME+FROM CITY+FROM STNAME|D:ST ZIP CF",
  // B — "From City [ST ZIP]" / "To ST ZIP 350cf", footer ready flag
  "H:FROM CITY+FROM CITY ST ZIP|D:TO ST ZIP CFu",
  // C — "NEW JERSEY" + "📍 Kearny", "400cf MI 48864 RFD"
  "H:PIN CITY+STNAME|D:CFu ST ZIP RFD",
  // D — "From:Kent ,Seattle ,WA", "To:KY 400 c/f-40741 RFD 9/9"
  "H:FROM CITY+FROM CITY ST|D:TO ST CFu CITY RFD+TO ST CFu ZIP+TO ST CFu ZIP DATE+TO ST CFu ZIP RFD+TO ST CFu ZIP RFD DATE",
  // E — "FROM AUBURN CA", "2000. FL 32439 $3.75 Bulky"
  "H:FROM CITY ST|D:CF ST ZIP PRICE+CF ST ZIP PRICE WORDS",
  // F — "FROM CHARLOTTE NC 28209:", "200 - CA 91916"
  "H:FROM CITY ST+FROM CITY ST ZIP|D:CF ST ZIP",
  // G — "FROM LA" + "To FL 33435 350cf"
  "H:FROM CITY|D:TO ST ZIP CFu",
  // H — one-line lanes "Newark NJ -> Miami FL 33101 350cf RFD"
  "H:LANE|D:",
  // I — "Desde Miami FL:" + numbered "1. GA 30303 400 $3.50 por cube" / "2. NC 28202 300 listo"
  "H:FROM CITY ST|D:ST ZIP CF+ST ZIP CF PRICE+ST ZIP CF RFD",
  // J — "OHIO" + "📍 Columbus" blocks with "ST ZIP CF" lines
  "H:PIN CITY+STNAME|D:ST ZIP CF",
  // K — F's shape with a city+state header only ("FROM DALLAS TX:" + "300 - FL 33101")
  "H:FROM CITY ST|D:CF ST ZIP",
  // A headerless continuation ("To FL 34113 200cf" minutes after a full post)
  "H:|D:TO ST ZIP CFu",
]);
