/**
 * Offline city gazetteer: city | state | lat | lng | representative ZIP.
 *
 * Deliberately curated rather than exhaustive -- it covers the metros and
 * freight hubs that actually appear in load posts, weighted toward the I-95
 * corridor where the seed data lives. It is the default geocoder so the whole
 * pipeline runs with no API key and no network. Configure GEOCODER=census or
 * =mapbox to resolve anything this list misses (results are cached in `places`,
 * so each unknown place costs one lookup ever).
 */

const RAW = `
Newark|NJ|40.7357|-74.1724|07102
Jersey City|NJ|40.7178|-74.0431|07302
Elizabeth|NJ|40.6639|-74.2107|07201
Edison|NJ|40.5187|-74.4121|08817
Paterson|NJ|40.9168|-74.1718|07501
Trenton|NJ|40.2171|-74.7429|08608
Camden|NJ|39.9259|-75.1196|08102
Bayonne|NJ|40.6687|-74.1143|07002
Secaucus|NJ|40.7895|-74.0565|07094
Carteret|NJ|40.5773|-74.2285|07008
Perth Amboy|NJ|40.5068|-74.2654|08861
South Plainfield|NJ|40.5793|-74.4116|07080
Cranbury|NJ|40.3162|-74.5138|08512
Mount Laurel|NJ|39.9340|-74.8910|08054
Atlantic City|NJ|39.3643|-74.4229|08401
Newburgh|NY|41.5034|-74.0104|12550
New York|NY|40.7128|-74.0060|10001
Brooklyn|NY|40.6782|-73.9442|11201
Queens|NY|40.7282|-73.7949|11101
Bronx|NY|40.8448|-73.8648|10451
Staten Island|NY|40.5795|-74.1502|10301
Yonkers|NY|40.9312|-73.8988|10701
Albany|NY|42.6526|-73.7562|12207
Buffalo|NY|42.8864|-78.8784|14202
Rochester|NY|43.1566|-77.6088|14604
Syracuse|NY|43.0481|-76.1474|13202
Binghamton|NY|42.0987|-75.9180|13901
Hempstead|NY|40.7062|-73.6187|11550
Philadelphia|PA|39.9526|-75.1652|19103
Pittsburgh|PA|40.4406|-79.9959|15222
Allentown|PA|40.6084|-75.4902|18101
Bethlehem|PA|40.6259|-75.3705|18015
Scranton|PA|41.4090|-75.6624|18503
Harrisburg|PA|40.2732|-76.8867|17101
Reading|PA|40.3356|-75.9269|19601
Lancaster|PA|40.0379|-76.3055|17602
Erie|PA|42.1292|-80.0851|16501
Chambersburg|PA|39.9376|-77.6611|17201
Carlisle|PA|40.2015|-77.2003|17013
Hazleton|PA|40.9581|-75.9746|18201
Wilkes-Barre|PA|41.2459|-75.8813|18701
Boston|MA|42.3601|-71.0589|02108
Worcester|MA|42.2626|-71.8023|01608
Springfield|MA|42.1015|-72.5898|01103
Chicopee|MA|42.1487|-72.6079|01013
Providence|RI|41.8240|-71.4128|02903
Hartford|CT|41.7658|-72.6734|06103
New Haven|CT|41.3083|-72.9279|06510
Bridgeport|CT|41.1865|-73.1952|06604
Stamford|CT|41.0534|-73.5387|06901
Waterbury|CT|41.5582|-73.0515|06702
Portland|ME|43.6591|-70.2568|04101
Bangor|ME|44.8016|-68.7712|04401
Manchester|NH|42.9956|-71.4548|03101
Nashua|NH|42.7654|-71.4676|03060
Burlington|VT|44.4759|-73.2121|05401
Baltimore|MD|39.2904|-76.6122|21201
Hagerstown|MD|39.6418|-77.7200|21740
Frederick|MD|39.4143|-77.4105|21701
Silver Spring|MD|38.9907|-77.0261|20901
Washington|DC|38.9072|-77.0369|20001
Wilmington|DE|39.7391|-75.5398|19801
Dover|DE|39.1582|-75.5244|19901
Richmond|VA|37.5407|-77.4360|23219
Norfolk|VA|36.8508|-76.2859|23510
Virginia Beach|VA|36.8529|-75.9780|23451
Alexandria|VA|38.8048|-77.0469|22314
Arlington|VA|38.8816|-77.0910|22201
Roanoke|VA|37.2710|-79.9414|24011
Front Royal|VA|38.9182|-78.1944|22630
Charleston|WV|38.3498|-81.6326|25301
Charlotte|NC|35.2271|-80.8431|28202
Raleigh|NC|35.7796|-78.6382|27601
Greensboro|NC|36.0726|-79.7920|27401
Durham|NC|35.9940|-78.8986|27701
Winston-Salem|NC|36.0999|-80.2442|27101
Fayetteville|NC|35.0527|-78.8784|28301
Wilmington|NC|34.2257|-77.9447|28401
Columbia|SC|34.0007|-81.0348|29201
Charleston|SC|32.7765|-79.9311|29401
Greenville|SC|34.8526|-82.3940|29601
Atlanta|GA|33.7490|-84.3880|30303
Savannah|GA|32.0809|-81.0912|31401
Augusta|GA|33.4735|-82.0105|30901
Macon|GA|32.8407|-83.6324|31201
Columbus|GA|32.4610|-84.9877|31901
Miami|FL|25.7617|-80.1918|33101
Jacksonville|FL|30.3322|-81.6557|32202
Tampa|FL|27.9506|-82.4572|33602
Orlando|FL|28.5383|-81.3792|32801
Fort Lauderdale|FL|26.1224|-80.1373|33301
Hialeah|FL|25.8576|-80.2781|33010
West Palm Beach|FL|26.7153|-80.0534|33401
Miramar|FL|25.9861|-80.2323|33025
Naples|FL|26.1420|-81.7948|34102
Fort Myers|FL|26.6406|-81.8723|33901
Sarasota|FL|27.3364|-82.5307|34236
Ocala|FL|29.1872|-82.1401|34470
Tallahassee|FL|30.4383|-84.2807|32301
Lakeland|FL|28.0395|-81.9498|33801
Birmingham|AL|33.5186|-86.8104|35203
Montgomery|AL|32.3668|-86.3000|36104
Mobile|AL|30.6954|-88.0399|36602
Huntsville|AL|34.7304|-86.5861|35801
Jackson|MS|32.2988|-90.1848|39201
Memphis|TN|35.1495|-90.0490|38103
Nashville|TN|36.1627|-86.7816|37203
Knoxville|TN|35.9606|-83.9207|37902
Chattanooga|TN|35.0456|-85.3097|37402
Louisville|KY|38.2527|-85.7585|40202
Lexington|KY|38.0406|-84.5037|40507
Columbus|OH|39.9612|-82.9988|43215
Cleveland|OH|41.4993|-81.6944|44113
Cincinnati|OH|39.1031|-84.5120|45202
Toledo|OH|41.6528|-83.5379|43604
Akron|OH|41.0814|-81.5190|44308
Dayton|OH|39.7589|-84.1916|45402
Youngstown|OH|41.0998|-80.6495|44503
Detroit|MI|42.3314|-83.0458|48226
Grand Rapids|MI|42.9634|-85.6681|49503
Lansing|MI|42.7325|-84.5555|48933
Flint|MI|43.0125|-83.6875|48502
Indianapolis|IN|39.7684|-86.1581|46204
Fort Wayne|IN|41.0793|-85.1394|46802
South Bend|IN|41.6764|-86.2520|46601
Gary|IN|41.5934|-87.3464|46402
Chicago|IL|41.8781|-87.6298|60601
Joliet|IL|41.5250|-88.0817|60432
Rockford|IL|42.2711|-89.0940|61101
Peoria|IL|40.6936|-89.5890|61602
Springfield|IL|39.7817|-89.6501|62701
Elgin|IL|42.0354|-88.2826|60120
Milwaukee|WI|43.0389|-87.9065|53202
Madison|WI|43.0731|-89.4012|53703
Green Bay|WI|44.5133|-88.0133|54301
Minneapolis|MN|44.9778|-93.2650|55401
Saint Paul|MN|44.9537|-93.0900|55102
Duluth|MN|46.7867|-92.1005|55802
Des Moines|IA|41.5868|-93.6250|50309
Cedar Rapids|IA|41.9779|-91.6656|52401
Davenport|IA|41.5236|-90.5776|52801
Saint Louis|MO|38.6270|-90.1994|63101
Kansas City|MO|39.0997|-94.5786|64106
Springfield|MO|37.2090|-93.2923|65806
Columbia|MO|38.9517|-92.3341|65201
Wichita|KS|37.6872|-97.3301|67202
Topeka|KS|39.0473|-95.6752|66603
Kansas City|KS|39.1141|-94.6275|66101
Omaha|NE|41.2565|-95.9345|68102
Lincoln|NE|40.8136|-96.7026|68508
Sioux Falls|SD|43.5460|-96.7313|57104
Fargo|ND|46.8772|-96.7898|58102
Little Rock|AR|34.7465|-92.2896|72201
Fayetteville|AR|36.0626|-94.1574|72701
New Orleans|LA|29.9511|-90.0715|70112
Baton Rouge|LA|30.4515|-91.1871|70801
Shreveport|LA|32.5252|-93.7502|71101
Houston|TX|29.7604|-95.3698|77002
Dallas|TX|32.7767|-96.7970|75201
Fort Worth|TX|32.7555|-97.3308|76102
San Antonio|TX|29.4241|-98.4936|78205
Austin|TX|30.2672|-97.7431|78701
El Paso|TX|31.7619|-106.4850|79901
Laredo|TX|27.5306|-99.4803|78040
Corpus Christi|TX|27.8006|-97.3964|78401
Lubbock|TX|33.5779|-101.8552|79401
Amarillo|TX|35.2220|-101.8313|79101
McAllen|TX|26.2034|-98.2300|78501
Oklahoma City|OK|35.4676|-97.5164|73102
Tulsa|OK|36.1540|-95.9928|74103
Denver|CO|39.7392|-104.9903|80202
Colorado Springs|CO|38.8339|-104.8214|80903
Aurora|CO|39.7294|-104.8319|80010
Pueblo|CO|38.2544|-104.6091|81003
Salt Lake City|UT|40.7608|-111.8910|84101
Provo|UT|40.2338|-111.6585|84601
Albuquerque|NM|35.0844|-106.6504|87102
Santa Fe|NM|35.6870|-105.9378|87501
Phoenix|AZ|33.4484|-112.0740|85004
Tucson|AZ|32.2226|-110.9747|85701
Mesa|AZ|33.4152|-111.8315|85201
Flagstaff|AZ|35.1983|-111.6513|86001
Las Vegas|NV|36.1699|-115.1398|89101
Reno|NV|39.5296|-119.8138|89501
Boise|ID|43.6150|-116.2023|83702
Billings|MT|45.7833|-108.5007|59101
Cheyenne|WY|41.1400|-104.8202|82001
Los Angeles|CA|34.0522|-118.2437|90012
San Diego|CA|32.7157|-117.1611|92101
San Jose|CA|37.3382|-121.8863|95110
San Francisco|CA|37.7749|-122.4194|94102
Fresno|CA|36.7378|-119.7871|93721
Sacramento|CA|38.5816|-121.4944|95814
Long Beach|CA|33.7701|-118.1937|90802
Oakland|CA|37.8044|-122.2712|94607
Bakersfield|CA|35.3733|-119.0187|93301
Anaheim|CA|33.8366|-117.9143|92805
Riverside|CA|33.9533|-117.3962|92501
Stockton|CA|37.9577|-121.2908|95202
Ontario|CA|34.0633|-117.6509|91761
San Bernardino|CA|34.1083|-117.2898|92401
Portland|OR|45.5152|-122.6784|97204
Eugene|OR|44.0521|-123.0868|97401
Salem|OR|44.9429|-123.0351|97301
Seattle|WA|47.6062|-122.3321|98101
Spokane|WA|47.6588|-117.4260|99201
Tacoma|WA|47.2529|-122.4443|98402
Vancouver|WA|45.6387|-122.6615|98660
Anchorage|AK|61.2181|-149.9003|99501
Honolulu|HI|21.3069|-157.8583|96813
Rochester|MN|44.0121|-92.4802|55901
Grand Junction|CO|39.0639|-108.5506|81501
Cortez|CO|37.3489|-108.5859|81321
Sheridan|WY|44.7972|-106.9562|82801
Los Lunas|NM|34.8062|-106.7334|87031
Greece|NY|43.2098|-77.6931|14626
Mayfield Heights|OH|41.5190|-81.4579|44124
Kearny|NJ|40.7684|-74.1454|07032
Kent|WA|47.3809|-122.2348|98032
Woodburn|OR|45.1437|-122.8554|97071
Auburn|CA|38.8966|-121.0769|95603
Van Nuys|CA|34.1899|-118.4514|91401
`;

/**
 * Which "Springfield" a mover means when nothing else says. Used only when a
 * city-only header has no block state to lean on; the choice is flagged
 * `ambiguous_city` so a human can correct it once, as a learned place rule.
 */
export const PREFERRED_HOMONYM: Record<string, string> = {
  portland: "OR",
  columbus: "OH",
  charleston: "SC",
  springfield: "MO",
  wilmington: "NC",
  fayetteville: "NC",
  columbia: "SC",
  jackson: "MS",
  "kansas city": "MO",
  rochester: "NY",
};

export interface City {
  city: string;
  state: string;
  lat: number;
  lng: number;
  zip: string;
  /** lowercase "city, st" -- the primary lookup key */
  key: string;
}

export const CITIES: City[] = RAW.trim()
  .split("\n")
  .map((line) => {
    const [city, state, lat, lng, zip] = line.split("|");
    return {
      city,
      state,
      lat: Number(lat),
      lng: Number(lng),
      zip,
      key: `${city.toLowerCase()}, ${state.toLowerCase()}`,
    };
  });

/** "newark, nj" -> City (exact, unambiguous) */
export const CITY_BY_KEY = new Map(CITIES.map((c) => [c.key, c]));

/**
 * Bare city name -> candidates. Several are genuinely ambiguous
 * ("Springfield", "Columbus", "Portland", "Charleston"), so callers must
 * supply a state or accept the first, most populous match.
 */
export const CITY_BY_NAME = new Map<string, City[]>();
for (const c of CITIES) {
  const name = c.city.toLowerCase();
  const list = CITY_BY_NAME.get(name);
  if (list) list.push(c);
  else CITY_BY_NAME.set(name, [c]);
}

/** Nearest gazetteer city to a point -- used to label map clicks and ZIPs. */
export function nearestCity(lat: number, lng: number): City | null {
  let best: City | null = null;
  let bestDist = Infinity;
  for (const c of CITIES) {
    const d = (c.lat - lat) ** 2 + (c.lng - lng) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}
