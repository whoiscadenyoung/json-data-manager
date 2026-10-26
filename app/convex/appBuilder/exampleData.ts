/**
 * Sample data behind the seeded example apps (examples.ts). Values are
 * rounded approximations for demonstration — the dataset descriptions say
 * so — not an authoritative source.
 */

/** [name, state, region, established, area (acres), 2023 recreation visits (millions), longitude, latitude] */
export const NATIONAL_PARKS: ReadonlyArray<
  readonly [string, string, string, number, number, number, number, number]
> = [
  ["Great Smoky Mountains", "TN", "Southeast", 1934, 522427, 13.3, -83.51, 35.61],
  ["Grand Canyon", "AZ", "Southwest", 1919, 1201647, 4.7, -112.14, 36.06],
  ["Zion", "UT", "Southwest", 1919, 147243, 4.6, -113.03, 37.3],
  ["Rocky Mountain", "CO", "Mountain West", 1915, 265807, 4.1, -105.68, 40.34],
  ["Yellowstone", "WY", "Mountain West", 1872, 2219791, 4.5, -110.59, 44.43],
  ["Yosemite", "CA", "Pacific West", 1890, 761748, 3.9, -119.54, 37.86],
  ["Acadia", "ME", "Northeast", 1916, 49075, 3.9, -68.21, 44.34],
  ["Grand Teton", "WY", "Mountain West", 1929, 310044, 3.4, -110.8, 43.79],
  ["Joshua Tree", "CA", "Pacific West", 1994, 795156, 2.9, -115.9, 33.87],
  ["Olympic", "WA", "Pacific West", 1938, 922650, 2.9, -123.5, 47.8],
  ["Glacier", "MT", "Mountain West", 1910, 1013126, 3.0, -113.79, 48.7],
  ["Cuyahoga Valley", "OH", "Midwest", 2000, 32571, 2.9, -81.57, 41.24],
  ["Indiana Dunes", "IN", "Midwest", 2019, 15349, 2.8, -87.05, 41.65],
  ["Bryce Canyon", "UT", "Southwest", 1928, 35835, 2.5, -112.18, 37.59],
  ["Arches", "UT", "Southwest", 1971, 76679, 1.5, -109.59, 38.73],
  ["Hot Springs", "AR", "Southeast", 1921, 5554, 2.6, -93.05, 34.52],
  ["Shenandoah", "VA", "Southeast", 1935, 200192, 1.4, -78.32, 38.53],
  ["Mount Rainier", "WA", "Pacific West", 1899, 236381, 1.7, -121.73, 46.88],
  ["Sequoia", "CA", "Pacific West", 1890, 404064, 1.3, -118.57, 36.49],
  ["Everglades", "FL", "Southeast", 1934, 1508938, 1.1, -80.9, 25.29],
  ["Badlands", "SD", "Midwest", 1978, 242756, 1.0, -102.34, 43.86],
  ["Death Valley", "CA", "Pacific West", 1994, 3408407, 1.1, -116.82, 36.51],
  ["Denali", "AK", "Alaska", 1917, 4740911, 0.5, -150.5, 63.33],
  ["Haleakalā", "HI", "Pacific West", 1916, 33265, 0.9, -156.15, 20.72],
  ["Big Bend", "TX", "Southwest", 1944, 801163, 0.6, -103.25, 29.25],
  ["Mammoth Cave", "KY", "Southeast", 1941, 54016, 0.7, -86.1, 37.19],
  ["Voyageurs", "MN", "Midwest", 1975, 218200, 0.2, -92.84, 48.48],
  ["Gates of the Arctic", "AK", "Alaska", 1980, 7523897, 0.01, -153.3, 67.78],
];

/** [year, National Park System recreation visits (millions)] */
export const SYSTEM_VISITS: ReadonlyArray<readonly [number, number]> = [
  [2010, 281.3],
  [2011, 278.9],
  [2012, 282.8],
  [2013, 273.6],
  [2014, 292.8],
  [2015, 307.2],
  [2016, 330.9],
  [2017, 330.9],
  [2018, 318.2],
  [2019, 327.5],
  [2020, 237.1],
  [2021, 297.1],
  [2022, 311.9],
  [2023, 325.5],
];
