/**
 * REAL WhatsApp group messages, transcribed from screenshots the user supplied
 * on 2026-09-06. These are the ground truth the extractor is built against.
 *
 * Preserved exactly: emoji, glued units ("350cf", "500c/f"), messy commas
 * ("Kent ,Seattle ,WA"), irregular spacing, blank-line grouping, and the
 * "Read more" truncation. Sender and contact names are pseudonymised and every phone number
 * that appeared in the text is redacted to a 555 number -- the repo is
 * public and these are real people.
 *
 * WHAT THESE PROVE (and what the first freight-style design got wrong):
 *
 * 1. The dominant shape is a BATCH POST: one message is one sender's whole
 *    inventory, grouped by ORIGIN, with many DESTINATION lines each. Not one
 *    narrative message per job.
 * 2. Destinations are almost always "STATE ZIP" (occasionally a city name);
 *    origins are cities, sometimes with state/ZIP, declared once in a header
 *    line and inherited by every line below until the next header.
 * 3. CF is the ONLY quantity and appears as a bare number ("200"), "200cf",
 *    "200 cf", "200 c/f", "500c/f". A bare number on a destination line IS the
 *    cubic feet. There are no pallets, no lbs, no equipment types.
 * 4. "RFD" = Ready For Delivery: the goods are already picked up / in the
 *    warehouse and available now. "RFD 9/9" = available from that date.
 * 5. Contact is per SENDER (the WhatsApp author, or one footer line), never per
 *    job. Prices are usually absent.
 * 6. Senders re-post their inventory daily. The latest post from a sender
 *    supersedes their earlier ones: a job present on the 1st and absent on the
 *    5th has been delivered or taken. Messages 5 and 6 below are the SAME
 *    sender on different days -- the concrete case for that rule.
 * 7. When a price appears it is usually PER CUBIC FOOT ("$3.75", "$5 por cube"),
 *    so a 2000 cf job at $3.75 is a $7,500 job. Flat prices are rarer.
 * 8. Free-text notes ride at the end of a destination line: "Bulky", "URGENT",
 *    "HOT TUB", a carrier requirement, sometimes Spanish.
 *
 * The line grammar is therefore NOT positional. The same six tokens turn up in
 * different orders: [CF] [ST ZIP] [price] [RFD] [date] [notes]. A per-line
 * token-bag classifier plus a "current origin" state machine over header lines
 * covers every format here; matching line templates one by one does not.
 */

export interface RealMessage {
  /** Which written format this is, for the taxonomy in the spec. */
  format:
    | "A-header-bare-lines"
    | "B-from-to-lines"
    | "C-cf-first-lines"
    | "D-cf-slash-zip"
    | "E-cf-dot-price-per-cf"
    | "F-cf-dash-lines";
  author: string;
  authorPhone: string | null;
  group: string;
  body: string;
  /** What a human reads out of it -- the expected extraction. */
  expected: {
    origin: string;
    /** [destination text as written, cubic feet, flags] */
    jobs: Array<[string, number, string?]>;
  }[];
  notes: string;
}

export const REAL_MESSAGES: RealMessage[] = [
  {
    format: "A-header-bare-lines",
    author: "Dispatcher A",
    authorPhone: "+16035550100",
    group: "Movers Nationwide",
    body: `🚚Ready for Delivery From California 🚚

🏙FROM Los Angeles🏙

NY 11217              200
WV 25276      1000
OK 73054      1200
MI 48118            350
MT 59405      800
TN 38558      1700

🚚🚚From Sacramento🚚

VA 24040      450
NJ 08234       200
IL 60657     400
MD 21210     50
TX 76010      200
TN 37343      1000
OK 73071      400
TN 37064      400

🏞Rochester, Minnesota 🏞

MT 59401     200
 MT 59901     1700

NC 27520     200
FL 32136            1056
FL 32606     350

AZ 85255     400
AZ 85324     400
CA 95961     200
NM 87935     800
VA 20132     200
VA 23503     500`,
    expected: [
      {
        origin: "Los Angeles, CA",
        jobs: [
          ["NY 11217", 200],
          ["WV 25276", 1000],
          ["OK 73054", 1200],
          ["MI 48118", 350],
          ["MT 59405", 800],
          ["TN 38558", 1700],
        ],
      },
      {
        origin: "Sacramento, CA",
        jobs: [
          ["VA 24040", 450],
          ["NJ 08234", 200],
          ["IL 60657", 400],
          ["MD 21210", 50],
          ["TX 76010", 200],
          ["TN 37343", 1000],
          ["OK 73071", 400],
          ["TN 37064", 400],
        ],
      },
      {
        origin: "Rochester, MN",
        jobs: [
          ["MT 59401", 200],
          ["MT 59901", 1700],
          ["NC 27520", 200],
          ["FL 32136", 1056],
          ["FL 32606", 350],
          ["AZ 85255", 400],
          ["AZ 85324", 400],
          ["CA 95961", 200],
          ["NM 87935", 800],
          ["VA 20132", 200],
          ["VA 23503", 500],
        ],
      },
    ],
    notes:
      "Title line names a state ('From California'); the city headers below are more specific and win. " +
      "Bare numbers are CF. Blank lines group visually but do NOT reset the origin -- the NC/FL/AZ/... " +
      "blocks all sit under Rochester, MN. The 'MT 59901' line has a leading space. 'MD 21210 50' is a " +
      "genuine 50 CF job. All three origins have California/Minnesota state only in the title/header, " +
      "so state must be inferred for 'Los Angeles' and 'Sacramento' from the gazetteer.",
  },
  {
    format: "B-from-to-lines",
    author: "Dispatch (unnamed)",
    authorPhone: null,
    group: "Movers Nationwide",
    body: `From Grand Junction
To  FL 33435 350cf
To  MA 02072 500cf

From Cortez CO 81321
To NM 87825 250cf

From Sheridan WY 82801
To TN 37415 300cf

From Santa Fe NM 87505
To FL 32606 600cf
To VA 22314 300cf

From Los Lunas NM 87031
To TN 37921 700cf

From Albuquerque NM 87111
To NY 14201  200cf

From Greece NY 14626
To SC 29649 250cf

From Boston MA 02132
To FL 34113 200cf

From Salt Lake City UT 84116
To NH 03031 200cf
To VA 20171 300cf
To OK 74014 300cf
To IN 46845 1000cf

From Mayfield Heights OH 44124
To FL 32446  200cf

All jobs are ready for delivery`,
    expected: [
      { origin: "Grand Junction, CO", jobs: [["FL 33435", 350], ["MA 02072", 500]] },
      { origin: "Cortez, CO 81321", jobs: [["NM 87825", 250]] },
      { origin: "Sheridan, WY 82801", jobs: [["TN 37415", 300]] },
      { origin: "Santa Fe, NM 87505", jobs: [["FL 32606", 600], ["VA 22314", 300]] },
      { origin: "Los Lunas, NM 87031", jobs: [["TN 37921", 700]] },
      { origin: "Albuquerque, NM 87111", jobs: [["NY 14201", 200]] },
      { origin: "Greece, NY 14626", jobs: [["SC 29649", 250]] },
      { origin: "Boston, MA 02132", jobs: [["FL 34113", 200]] },
      {
        origin: "Salt Lake City, UT 84116",
        jobs: [["NH 03031", 200], ["VA 20171", 300], ["OK 74014", 300], ["IN 46845", 1000]],
      },
      { origin: "Mayfield Heights, OH 44124", jobs: [["FL 32446", 200]] },
    ],
    notes:
      "'From <City> [ST] [ZIP]' header, 'To <ST> <ZIP> <N>cf' lines, cf glued to the number. " +
      "'Grand Junction' has no state -- it is in Colorado and only a gazetteer/geocoder knows that. " +
      "'Greece NY' and 'Los Lunas NM' and 'Mayfield Heights OH' are small towns the curated gazetteer " +
      "will not contain; the origin ZIP is the reliable anchor. Footer 'All jobs are ready for delivery' " +
      "applies RFD to every job.",
  },
  {
    format: "C-cf-first-lines",
    author: "Dispatcher C",
    authorPhone: "+12015550199",
    group: "NJ Movers Loads",
    body: `🚚🚛🔥 ‼️LOAD POST‼️ 🔥🚚



NEW JERSEY
📍 Kearny
400cf MI  48864 RFD
200cf LA 70119 RFD
200cf FL 33982 RFD
200cf FL 33180 RFD
350cf FL 33909 RFD
400cf FL 32218 RFD
300cf FL 34957 RFD
500cf SC 29588 RFD



✅ Must have active DOT & MC
📱 Call/Text Marco: (201) 555-0199`,
    expected: [
      {
        origin: "Kearny, NJ",
        jobs: [
          ["MI 48864", 400, "RFD"],
          ["LA 70119", 200, "RFD"],
          ["FL 33982", 200, "RFD"],
          ["FL 33180", 200, "RFD"],
          ["FL 33909", 350, "RFD"],
          ["FL 32218", 400, "RFD"],
          ["FL 34957", 300, "RFD"],
          ["SC 29588", 500, "RFD"],
        ],
      },
    ],
    notes:
      "Origin is TWO lines: a state name in caps ('NEW JERSEY') then a pin-emoji city line ('📍 Kearny'). " +
      "Destination lines are CF FIRST: '<N>cf <ST> <ZIP> RFD'. 'LA' here is LOUISIANA (ZIP 70119), not Los " +
      "Angeles -- the ZIP disambiguates and must win over the alias. Contact is one footer line for the " +
      "whole post. 'Must have active DOT & MC' is a carrier requirement note, not a job.",
  },
  {
    format: "D-cf-slash-zip",
    author: "Dispatcher D",
    authorPhone: "+14105550188",
    group: "Movers Nationwide",
    body: `🇺🇸 💰 From:Kent ,Seattle ,WA
To: AL  300 c/f-36561

🇺🇸 💰 From:Woodburn ,OR 💰
To:KY 400 c/f-40741 RFD 9/9
To:NC 300 c/f-28463
To:TN 800 c/f-37040 RFD 9/8
To:FL 1300 c/f-32162 9/12

🇺🇸 💰 From :Dallas , TX 💰
To:UT 400 c/f-84110 RFD 9/12
To:WA 200 c/f-98034
To:ID 400 c/f-83607
To:CO 600 c/f-80201
To:CO 950 c/f-80504

🇺🇸 💰 From:Sacramento,CA💰
To:CO 1000 c/f-80906 RFD
To:MN 700 c/f-55044
To:IN 650 c/f-46619
To:TX 350 c/f-77979  RFD
💰 From :San Jose CA
To:NY 300 c/f-14845
To:MN 500c/f-55128
To:MO 200 c/f-63043
To:TN 300c/f-37920
To:MA 300c/f-01970
To:IL  250c/f-60657

🇺🇸 💰 From:Los Angeles ,CA💰
To:ID 200 c/f-83664
To:MT 250 c/f-59327
To:NV 200 c/f-89101 RFD
To:CO 600 c/f-80216 RFD
To:CO 200 c/f-Denver RFD
To:IA 200 c/f-50613 RFD
To:IA 600 c/f`,
    expected: [
      { origin: "Kent, WA", jobs: [["AL 36561", 300]] },
      {
        origin: "Woodburn, OR",
        jobs: [
          ["KY 40741", 400, "RFD 9/9"],
          ["NC 28463", 300],
          ["TN 37040", 800, "RFD 9/8"],
          ["FL 32162", 1300, "9/12"],
        ],
      },
      {
        origin: "Dallas, TX",
        jobs: [
          ["UT 84110", 400, "RFD 9/12"],
          ["WA 98034", 200],
          ["ID 83607", 400],
          ["CO 80201", 600],
          ["CO 80504", 950],
        ],
      },
      {
        origin: "Sacramento, CA",
        jobs: [["CO 80906", 1000, "RFD"], ["MN 55044", 700], ["IN 46619", 650], ["TX 77979", 350, "RFD"]],
      },
      {
        origin: "San Jose, CA",
        jobs: [
          ["NY 14845", 300],
          ["MN 55128", 500],
          ["MO 63043", 200],
          ["TN 37920", 300],
          ["MA 01970", 300],
          ["IL 60657", 250],
        ],
      },
      {
        origin: "Los Angeles, CA",
        jobs: [
          ["ID 83664", 200],
          ["MT 59327", 250],
          ["NV 89101", 200, "RFD"],
          ["CO 80216", 600, "RFD"],
          ["CO Denver", 200, "RFD"],
          ["IA 50613", 200, "RFD"],
        ],
      },
    ],
    notes:
      "'From:<City> ,<ST>' with commas and spaces in random places ('Kent ,Seattle ,WA' means Kent, a " +
      "suburb of Seattle). Destination lines: 'To:<ST> <N> c/f-<ZIP>' -- the CF unit is 'c/f' and a DASH " +
      "joins it to the ZIP; sometimes no space before c/f ('500c/f-55128'). One line has a CITY instead " +
      "of a ZIP ('c/f-Denver'). 'RFD 9/9' is ready-for-delivery on a date; a bare '9/12' means the same. " +
      "A header can appear WITHOUT a blank line before it ('💰 From :San Jose CA' right after the Sacramento " +
      "block). The message was truncated by WhatsApp ('Read more') after 'To:IA 600 c/f' -- the last " +
      "line has no ZIP and must not be fabricated into a job.",
  },
  {
    format: "E-cf-dot-price-per-cf",
    author: "Dispatcher E",
    authorPhone: "+17865550128",
    group: "Movers Nationwide",
    body: `FROM AUBURN CA
2000.    FL 32439 $3.75 Bulky URGET ranger
300.      MS 39759 $3.5

FROM PHOENIX AZ:
300 - MI 48341 $3.00
200. -RI 02912   $5 por cube
850. FL 34275.   $3.5
550.   IN 46235.  $3.00



FROM TUCSON AZ
200.    PA 16648 $3.25

FROM SAN FERNANDO VALLEY CA:
1600. MO 65721 $3.25


FROM SAN DIEGO CA:
250 - PA 15012 $3.75

FROM ALBUQUERQUE NM:
750.   FL 34698 $3.00 HOT TUBE
200.   SC 29073 $3.00


🚛🚛🚛🚛🚛🚛🚛🚛🚛

MESSAGE IN PRIVATE.
VICTOR
786-555-0128
DANI R.
347-555-0171

🍇🍒🍇🍒🍇🍒🍇🍒🍇🍒🍇🍒🍇🍒🍇🍒🍇🍒

MUST HAVE ACTIVE DOT AND INSURANCE. GOOD BUSINESS IS EXPECTED AND REQUIRED.`,
    expected: [
      {
        origin: "Auburn, CA",
        jobs: [["FL 32439", 2000, "$3.75/cf; bulky; urgent"], ["MS 39759", 300, "$3.50/cf"]],
      },
      {
        origin: "Phoenix, AZ",
        jobs: [
          ["MI 48341", 300, "$3.00/cf"],
          ["RI 02912", 200, "$5.00/cf"],
          ["FL 34275", 850, "$3.50/cf"],
          ["IN 46235", 550, "$3.00/cf"],
        ],
      },
      { origin: "Tucson, AZ", jobs: [["PA 16648", 200, "$3.25/cf"]] },
      { origin: "San Fernando Valley, CA", jobs: [["MO 65721", 1600, "$3.25/cf"]] },
      { origin: "San Diego, CA", jobs: [["PA 15012", 250, "$3.75/cf"]] },
      {
        origin: "Albuquerque, NM",
        jobs: [["FL 34698", 750, "$3.00/cf; hot tub"], ["SC 29073", 200, "$3.00/cf"]],
      },
    ],
    notes:
      "CF first with a trailing PERIOD ('2000.', '850.') -- a typing habit, not a decimal. Separators vary " +
      "within one message: '2000.    FL', '300 - MI', '200. -RI'. A stray period after the ZIP ('34275.'). " +
      "Price is PER CUBIC FOOT: '$3.75', '$3.5', and in Spanish '$5 por cube'. Trailing notes: 'Bulky URGET " +
      "ranger' (bulky, urgent, misspelt), 'HOT TUBE' (a hot tub). Two named contacts with numbers in a " +
      "footer; 'MESSAGE IN PRIVATE' means DM, not a job. Origin headers are ALL CAPS 'FROM CITY ST' with an " +
      "optional colon; 'SAN FERNANDO VALLEY' is a region of Los Angeles, not a gazetteer city.",
  },
  {
    format: "F-cf-dash-lines",
    author: "Dispatcher E",
    authorPhone: "+17865550128",
    group: "Movers Nationwide",
    body: `🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴

      🔥LOAD POST🔥

FROM CHARLOTTE NC 28209:
200 - CA 91916

FROM FORT LAUDERDALE FL:
700 - OR 97396
200 - WA 98109
400 - OH 44473
300 - MI 49456
400 - NY 14075
200 - NY 14850
300 - AZ 85281
200 - CA 91977

🚛🚛🚛🚛🚛🚛🚛🚛🚛

MESSAGE IN PRIVATE.
VICTOR
786-555-0128
DANI
347-555-0171

🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴🌴

MUST HAVE HHG, ACTIVE DOT AND INSURANCE. GOOD BUSINESS IS EXPECTED AND REQUIRED.`,
    expected: [
      { origin: "Charlotte, NC 28209", jobs: [["CA 91916", 200]] },
      {
        origin: "Fort Lauderdale, FL",
        jobs: [
          ["OR 97396", 700],
          ["WA 98109", 200],
          ["OH 44473", 400],
          ["MI 49456", 300],
          ["NY 14075", 400],
          ["NY 14850", 200],
          ["AZ 85281", 300],
          ["CA 91977", 200],
        ],
      },
    ],
    notes:
      "Same sender as message E on a different day: a different inventory (FL and NC origins instead of " +
      "CA/AZ/NM). Under the latest-post-wins rule, when this arrives AFTER message E, E's jobs that do not " +
      "appear here are retired. Format: '<CF> - <ST> <ZIP>', no prices. 'HHG' = household goods authority, " +
      "a carrier requirement, not a job. Decorative emoji rows and the 'LOAD POST' title carry no data.",
  },
];
