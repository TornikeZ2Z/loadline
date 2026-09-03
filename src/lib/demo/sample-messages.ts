/**
 * Sample WhatsApp traffic.
 *
 * Written to look like the real thing, including the parts that make the
 * pipeline earn its keep:
 *   - informal place names (philly, socal, north jersey, EWR)
 *   - relative dates that only resolve against the send time
 *   - one message carrying several lanes
 *   - pure chatter that must NOT become a load
 *   - the same load reposted later and forwarded into a second group
 *   - a stale post that should land already expired
 *
 * Timestamps are relative to the seed run so "tomorrow" always means tomorrow.
 */

export interface SeedMessage {
  group: string;
  author: string;
  phone?: string;
  /** Hours before the seed run that this was sent. */
  hoursAgo: number;
  body: string;
}

export const GROUPS = [
  { waId: "120363011111111111@g.us", name: "NJ/NY Loads Daily", description: "North Jersey and NYC metro freight" },
  { waId: "120363022222222222@g.us", name: "East Coast Dispatch", description: "I-95 corridor, ME to FL" },
  { waId: "120363033333333333@g.us", name: "Reefer Runs USA", description: "Temperature-controlled loads nationwide" },
  { waId: "120363044444444444@g.us", name: "Box Truck & Sprinter Network", description: "Small freight and expedited" },
];

export const MESSAGES: SeedMessage[] = [
  // --- straightforward posts -------------------------------------------------
  {
    group: "NJ/NY Loads Daily",
    author: "Peter Kaz",
    phone: "+19735551234",
    hoursAgo: 3,
    body: "Tomorrow NJ → PA, pickup Newark, delivery Pittsburgh, 2 pallets, call Peter 973-555-1234",
  },
  {
    group: "NJ/NY Loads Daily",
    author: "Peter Kaz",
    phone: "+19735551234",
    hoursAgo: 2.5,
    body: "Peter has a load tomorrow from Newark going to Boston. Pickup around 10. Call 973-555-1234.",
  },
  {
    group: "NJ/NY Loads Daily",
    author: "Dispatch Rosa",
    phone: "+19085557788",
    hoursAgo: 5,
    body: "Need someone for Philly to Miami tomorrow. 44,000 lbs dry van. $3200. Rosa 908-555-7788",
  },
  {
    group: "East Coast Dispatch",
    author: "Mike T",
    phone: "+12155559090",
    hoursAgo: 8,
    body: "elizabeth nj 07201 -> charlotte nc 28202 today after 2pm, 18 pallets, 38k lbs, call mike 215-555-9090",
  },
  {
    group: "East Coast Dispatch",
    author: "Ahmed",
    phone: "+17185552211",
    hoursAgo: 1,
    body: "EWR to ORD tmrw morning, 53' van, 40000lbs. 718-555-2211",
  },
  {
    group: "NJ/NY Loads Daily",
    author: "Sal",
    phone: "+19735554433",
    hoursAgo: 6,
    body: "Jersey City to Baltimore MD 9/5, 6 pallets, liftgate needed. Sal",
  },

  // --- multi-lane message ----------------------------------------------------
  {
    group: "East Coast Dispatch",
    author: "Vlad",
    phone: "+12675558833",
    hoursAgo: 4,
    body: `3 loads all tmrw, call me 267-555-8833:
newark -> boston 12 plts
edison nj -> pitt 44k lbs
carteret -> richmond va reefer`,
  },
  {
    group: "Box Truck & Sprinter Network",
    author: "Lena",
    phone: "+19175556677",
    hoursAgo: 7,
    body: `sprinter loads today:
secaucus -> philly 4 skids
bayonne -> hartford ct 2 skids
917-555-6677 Lena`,
  },

  // --- informal / regional names ---------------------------------------------
  {
    group: "East Coast Dispatch",
    author: "Tony B",
    phone: "+18565553311",
    hoursAgo: 9,
    body: "north jersey to south florida, pickup mon, 22 pallets, reefer preferred. Tony 856-555-3311",
  },
  {
    group: "Reefer Runs USA",
    author: "Carlos",
    phone: "+13055559988",
    hoursAgo: 11,
    body: "socal to phx wednesday, produce, 42000 lbs, temp 34F. Carlos 305-555-9988",
  },
  {
    group: "East Coast Dispatch",
    author: "Danny",
    phone: "+14045552121",
    hoursAgo: 10,
    body: "atl -> nash next tuesday, flatbed, steel coils 46k. Danny 404-555-2121",
  },
  {
    group: "NJ/NY Loads Daily",
    author: "Yosef",
    phone: "+18455554455",
    hoursAgo: 13,
    body: "the city to lakewood nj today, 3 pallets furniture, 845-555-4455",
  },

  // --- chatter that must not become a load -----------------------------------
  { group: "NJ/NY Loads Daily", author: "Ruslan", hoursAgo: 2, body: "Good morning everyone 🙏" },
  { group: "NJ/NY Loads Daily", author: "Driver Ken", hoursAgo: 2.2, body: "empty in Newark, looking for loads to the midwest" },
  { group: "East Coast Dispatch", author: "Marcus", hoursAgo: 3.4, body: "still available?" },
  { group: "East Coast Dispatch", author: "Rosa", hoursAgo: 3.2, body: "taken" },
  { group: "Reefer Runs USA", author: "Omar", hoursAgo: 4.5, body: "these rates are too low man, nobody can run for that" },
  { group: "Box Truck & Sprinter Network", author: "Nina", hoursAgo: 5.5, body: "thanks!" },
  { group: "NJ/NY Loads Daily", author: "Admin", hoursAgo: 20, body: "Reminder: post rate and weight with every load please. No driver availability posts in this group." },

  // --- duplicates: same load reposted, and forwarded to another group ---------
  {
    group: "NJ/NY Loads Daily",
    author: "Dispatch Rosa",
    phone: "+19085557788",
    hoursAgo: 1.2,
    body: "STILL OPEN - philly to miami tomorrow, 44000 lbs, dry van, 3200. call rosa 908-555-7788",
  },
  {
    group: "East Coast Dispatch",
    author: "Rosa (fwd)",
    phone: "+19085557788",
    hoursAgo: 0.8,
    body: "Philadelphia PA -> Miami FL, pickup tomorrow, 44k, van, $3200, Rosa 9085557788",
  },
  {
    group: "East Coast Dispatch",
    author: "Mike T",
    phone: "+12155559090",
    hoursAgo: 7.5,
    body: "reposting: elizabeth nj to charlotte nc today, 18 plts 38000 lbs, mike 215-555-9090",
  },

  // --- already stale, should be expired by the sweep --------------------------
  {
    group: "East Coast Dispatch",
    author: "Greg",
    phone: "+16105557766",
    hoursAgo: 72,
    body: "allentown pa to columbus oh yesterday, 20 pallets, 610-555-7766",
  },
  {
    group: "NJ/NY Loads Daily",
    author: "Ivan",
    phone: "+17325551199",
    hoursAgo: 60,
    body: "perth amboy -> atlanta ga 2 days ago 44k lbs, ivan 732-555-1199",
  },

  // --- corridor-matching fodder: NJ/PA -> GA/FL lanes and midpoints ----------
  {
    group: "East Coast Dispatch",
    author: "Bill",
    phone: "+12025553344",
    hoursAgo: 12,
    body: "philadelphia to washington dc tomorrow, 8 pallets, 202-555-3344 Bill",
  },
  {
    group: "East Coast Dispatch",
    author: "Shauna",
    phone: "+17045557711",
    hoursAgo: 14,
    body: "washington dc -> charlotte nc tomorrow, dry van 44k, Shauna 704-555-7711",
  },
  {
    group: "East Coast Dispatch",
    author: "Reggie",
    phone: "+14705558822",
    hoursAgo: 15,
    body: "charlotte to atlanta tomorrow 30k lbs, reggie 470-555-8822",
  },
  {
    group: "East Coast Dispatch",
    author: "Pam",
    phone: "+18045556655",
    hoursAgo: 16,
    body: "richmond va to savannah ga tmrw, 14 pallets, 804-555-6655",
  },
  {
    group: "East Coast Dispatch",
    author: "Luis",
    phone: "+19195554400",
    hoursAgo: 17,
    body: "raleigh nc -> jacksonville fl tomorrow, reefer, 38000, luis 919-555-4400",
  },
  {
    group: "NJ/NY Loads Daily",
    author: "Hank",
    phone: "+12015552200",
    hoursAgo: 18,
    body: "newark -> albany ny tomorrow 5 pallets, hank 201-555-2200",
  },

  // --- volume: spread across states, dates, equipment ------------------------
  { group: "Reefer Runs USA", author: "Bo", phone: "+17735551010", hoursAgo: 19, body: "chicago il to denver co friday, reefer, 41000 lbs, bo 773-555-1010" },
  { group: "Reefer Runs USA", author: "Grace", phone: "+12145552323", hoursAgo: 21, body: "dallas tx -> phoenix az this week, produce reefer 44k, grace 214-555-2323" },
  { group: "Reefer Runs USA", author: "Trent", phone: "+15035554545", hoursAgo: 22, body: "portland or to seattle wa tomorrow, 12 pallets frozen, trent 503-555-4545" },
  { group: "East Coast Dispatch", author: "Nadia", phone: "+16175556767", hoursAgo: 23, body: "boston ma -> providence ri today, 4 pallets, nadia 617-555-6767" },
  { group: "East Coast Dispatch", author: "Sam", phone: "+14125558989", hoursAgo: 24, body: "pittsburgh pa to cleveland oh tomorrow 22 plts, sam 412-555-8989" },
  { group: "Box Truck & Sprinter Network", author: "Fitz", phone: "+13135551212", hoursAgo: 25, body: "detroit mi -> toledo oh today box truck 2000 lbs, fitz 313-555-1212" },
  { group: "Box Truck & Sprinter Network", author: "Rae", phone: "+16025553434", hoursAgo: 26, body: "phoenix to tucson tomorrow, sprinter, 1500 lbs hotshot, rae 602-555-3434" },
  { group: "East Coast Dispatch", author: "Dev", phone: "+18135555656", hoursAgo: 27, body: "tampa fl to orlando fl tomorrow 16 pallets, dev 813-555-5656" },
  { group: "East Coast Dispatch", author: "Joel", phone: "+19045557878", hoursAgo: 28, body: "jacksonville fl -> savannah ga in 2 days, flatbed lumber 45k, joel 904-555-7878" },
  { group: "NJ/NY Loads Daily", author: "Moshe", phone: "+18485559090", hoursAgo: 29, body: "lakewood nj to brooklyn ny today, 6 skids, moshe 848-555-9090" },
  { group: "NJ/NY Loads Daily", author: "Petra", phone: "+15165552121", hoursAgo: 30, body: "long island to edison nj tomorrow, 9 pallets, petra 516-555-2121" },
  { group: "East Coast Dispatch", author: "Kwan", phone: "+16145553232", hoursAgo: 31, body: "columbus oh -> indianapolis in wednesday, van 39000, kwan 614-555-3232" },
  { group: "East Coast Dispatch", author: "Ali", phone: "+13175554343", hoursAgo: 32, body: "indianapolis to st louis mo tomorrow 44k dry van, ali 317-555-4343" },
  { group: "Reefer Runs USA", author: "Wes", phone: "+16125555454", hoursAgo: 33, body: "minneapolis mn to milwaukee wi thursday reefer 30000, wes 612-555-5454" },
  { group: "East Coast Dispatch", author: "Gita", phone: "+17135556565", hoursAgo: 34, body: "houston tx -> new orleans la tomorrow, 20 pallets, gita 713-555-6565" },
  { group: "East Coast Dispatch", author: "Rob", phone: "+16155557676", hoursAgo: 35, body: "nashville tn to memphis tn today 15 plts, rob 615-555-7676" },
  { group: "NJ/NY Loads Daily", author: "Ari", phone: "+12015558787", hoursAgo: 36, body: "secaucus nj -> allentown pa tomorrow 10 pallets 12000 lbs, ari 201-555-8787" },
  { group: "NJ/NY Loads Daily", author: "Bea", phone: "+19735559898", hoursAgo: 37, body: "paterson nj to hartford ct tomorrow, 7 pallets, bea 973-555-9898" },
  { group: "East Coast Dispatch", author: "Cy", phone: "+14105551313", hoursAgo: 38, body: "baltimore md -> richmond va tomorrow, van 41k, cy 410-555-1313" },
  { group: "East Coast Dispatch", author: "Dot", phone: "+18035552424", hoursAgo: 39, body: "columbia sc to atlanta ga tomorrow 25 pallets, dot 803-555-2424" },
  { group: "Reefer Runs USA", author: "Emin", phone: "+12095553535", hoursAgo: 40, body: "stockton ca -> las vegas nv this week reefer 44000, emin 209-555-3535" },
  { group: "Box Truck & Sprinter Network", author: "Fay", phone: "+16195554646", hoursAgo: 41, body: "san diego ca to los angeles ca today sprinter 900 lbs, fay 619-555-4646" },

  // --- edge cases the extractor should handle gracefully ----------------------
  {
    group: "NJ/NY Loads Daily",
    author: "Unknown",
    hoursAgo: 44,
    body: "load available call me",   // no origin/destination -> skip
  },
  {
    group: "East Coast Dispatch",
    author: "Hal",
    phone: "+12395555757",
    hoursAgo: 45,
    body: "naples fl to somewhere up north tomorrow, 30k, hal 239-555-5757", // vague destination
  },
  {
    group: "East Coast Dispatch",
    author: "Iris",
    phone: "+15025556868",
    hoursAgo: 46,
    body: "louisville ky -> cincinnati oh 10/12 22 tons flatbed, iris 502-555-6868", // tons + numeric date
  },
];
