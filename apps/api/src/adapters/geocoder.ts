/**
 * Address search plug point. The development geocoder knows only a list of sample business
 * addresses (clearly labelled); a real EU geocoding provider replaces it.
 */
export interface Place {
  label: string;
  addressLine: string;
  postcode: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
  source: 'dev_sample' | 'provider';
}

export interface Geocoder {
  search(query: string, limit?: number): Promise<Place[]>;
}

const SAMPLE: Array<[string, string, string, string, number, number]> = [
  // addressLine, postcode, city, country, lat, lng
  ['Am Sandtorkai 1', '20457', 'Hamburg', 'DE', 53.5432, 9.9894],
  ['Industriestraße 10', '60314', 'Frankfurt am Main', 'DE', 50.1109, 8.7136],
  ['Messedamm 22', '14055', 'Berlin', 'DE', 52.5065, 13.2798],
  ['Ingolstädter Str. 20', '80807', 'München', 'DE', 48.1838, 11.5859],
  ['Lagerstraße 5', '50769', 'Köln', 'DE', 51.0303, 6.9128],
  ['Maasvlakte Plaza 1', '3199 LZ', 'Rotterdam', 'NL', 51.9563, 4.0617],
  ['Schiphol Boulevard 101', '1118 BG', 'Schiphol', 'NL', 52.3086, 4.7639],
  ['Noorderlaan 147', '2030', 'Antwerpen', 'BE', 51.2558, 4.4064],
  ['Rue de Rivoli 10', '75004', 'Paris', 'FR', 48.8556, 2.3601],
  ['Avenue Jean Jaurès 50', '69007', 'Lyon', 'FR', 45.7392, 4.8392],
  ['Calle de Alcalá 100', '28009', 'Madrid', 'ES', 40.4225, -3.6797],
  ['Carrer de la Zona Franca 1', '08040', 'Barcelona', 'ES', 41.3456, 2.1307],
  ['Calle Triana 1', '35002', 'Las Palmas de Gran Canaria', 'ES', 28.1065, -15.4155],
  ['Via Mecenate 76', '20138', 'Milano', 'IT', 45.4462, 9.2384],
  ['Via Tiburtina 1000', '00156', 'Roma', 'IT', 41.9216, 12.5751],
  ['Ul. Marszałkowska 10', '00-590', 'Warszawa', 'PL', 52.2215, 21.0177],
  ['Ul. Logistyczna 1', '55-040', 'Wrocław', 'PL', 51.0542, 16.9666],
  ['Ul. Portowa 2', '80-601', 'Gdańsk', 'PL', 54.3962, 18.6712],
  ['Na Příkopě 10', '110 00', 'Praha', 'CZ', 50.0857, 14.4243],
  ['Wiener Straße 1', '1100', 'Wien', 'AT', 48.1769, 16.3778],
  ['Váci út 1', '1062', 'Budapest', 'HU', 47.5137, 19.0573],
  ['Vestergade 1', '1456', 'København', 'DK', 55.6782, 12.5725],
  ['Frihamnen 1', '417 70', 'Göteborg', 'SE', 57.7171, 11.9431],
  ['Sveavägen 10', '111 57', 'Stockholm', 'SE', 59.3346, 18.0632],
  ['Karl Johans gate 1', '0154', 'Oslo', 'NO', 59.9111, 10.7503],
  ['Bryggen 1', '5003', 'Bergen', 'NO', 60.3971, 5.3245],
  ['Bahnhofstrasse 1', '8001', 'Zürich', 'CH', 47.3721, 8.539],
  ['Rue du Rhône 1', '1204', 'Genève', 'CH', 46.2034, 6.1462],
  ['Trafford Park Road 1', 'M17 1HH', 'Manchester', 'GB', 53.4665, -2.3171],
  ['Dover Eastern Docks', 'CT16 1JA', 'Dover', 'GB', 51.1279, 1.3343],
  ['Donegall Quay 1', 'BT1 3EA', 'Belfast', 'GB', 54.6015, -5.9218],
  ['North Wall Quay 1', 'D01 T8Y1', 'Dublin', 'IE', 53.3488, -6.235],
  ['Rua Augusta 1', '1100-053', 'Lisboa', 'PT', 38.7097, -9.1367],
  ['Mannerheimintie 1', '00100', 'Helsinki', 'FI', 60.1689, 24.9399],
  ['Strada Fabrica de Glucoză 1', '020331', 'București', 'RO', 44.4797, 26.1121],
];

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

export class DevSampleGeocoder implements Geocoder {
  async search(query: string, limit = 8): Promise<Place[]> {
    const words = fold(query)
      .split(/[\s,]+/)
      .filter(Boolean);
    if (words.length === 0) return [];
    return SAMPLE.filter(([a, p, c, k]) => {
      const hay = fold(`${a} ${p} ${c} ${k}`);
      return words.every((w) => hay.includes(w));
    })
      .slice(0, limit)
      .map(([addressLine, postcode, city, country, lat, lng]) => ({
        label: `${addressLine}, ${postcode} ${city}, ${country}`,
        addressLine,
        postcode,
        city,
        country,
        lat,
        lng,
        source: 'dev_sample' as const,
      }));
  }
}
