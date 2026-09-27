pub mod chinese;
pub mod english;

use std::collections::HashMap;

use once_cell::sync::Lazy;

pub const PUNCTUATIONS: [&str; 7] = ["!", "?", "…", ",", ".", "'", "-"];
pub const PAD: &str = "_";

pub static SYMBOLS: Lazy<Vec<&'static str>> = Lazy::new(|| {
    let punctuation_symbols = {
        let mut v = PUNCTUATIONS.to_vec();
        v.extend(["SP", "UNK"]);
        v
    };
    let mut normal = ZH_SYMBOLS.to_vec();
    normal.extend(JP_SYMBOLS);
    normal.extend(EN_SYMBOLS);
    normal.sort();
    normal.dedup();
    let mut symbols = Vec::with_capacity(1 + normal.len() + punctuation_symbols.len());
    symbols.push(PAD);
    symbols.extend(normal);
    symbols.extend(punctuation_symbols);
    symbols
});

pub static SYMBOL_ID_MAP: Lazy<HashMap<&'static str, usize>> = Lazy::new(|| {
    SYMBOLS
        .iter()
        .enumerate()
        .map(|(idx, &symbol)| (symbol, idx))
        .collect()
});

pub static SIL_PHONEME_IDS: Lazy<Vec<usize>> = Lazy::new(|| {
    PUNCTUATIONS
        .iter()
        .chain(["SP", "UNK"].iter())
        .filter_map(|symbol| SYMBOLS.iter().position(|s| s == symbol))
        .collect()
});

pub static LANGUAGE_ID_MAP: Lazy<HashMap<&'static str, usize>> =
    Lazy::new(|| HashMap::from_iter([("ZH", 0usize), ("JP", 1), ("EN", 2)]));

pub static LANGUAGE_TONE_START_MAP: Lazy<HashMap<&'static str, usize>> = Lazy::new(|| {
    HashMap::from_iter([
        ("ZH", 0usize),
        ("JP", NUM_ZH_TONES),
        ("EN", NUM_ZH_TONES + NUM_JP_TONES),
    ])
});

pub const NUM_ZH_TONES: usize = 6;
pub const NUM_JP_TONES: usize = 2;
pub const NUM_EN_TONES: usize = 4;
pub const NUM_TONES: usize = NUM_ZH_TONES + NUM_JP_TONES + NUM_EN_TONES;

pub static ZH_SYMBOLS: &[&str] = &[
    "E", "En", "a", "ai", "an", "ang", "ao", "b", "c", "ch", "d", "e", "ei", "en", "eng", "er",
    "f", "g", "h", "i", "i0", "ia", "ian", "iang", "iao", "ie", "in", "ing", "iong", "ir", "iu",
    "j", "k", "l", "m", "n", "o", "ong", "ou", "p", "q", "r", "s", "sh", "t", "u", "ua", "uai",
    "uan", "uang", "ui", "un", "uo", "v", "van", "ve", "vn", "w", "x", "y", "z", "zh", "AA", "EE",
    "OO",
];

pub static JP_SYMBOLS: &[&str] = &[
    "N", "a", "a:", "b", "by", "ch", "d", "dy", "e", "e:", "f", "g", "gy", "h", "hy", "i", "i:",
    "j", "k", "ky", "m", "my", "n", "ny", "o", "o:", "p", "py", "q", "r", "ry", "s", "sh", "t",
    "ts", "ty", "u", "u:", "w", "y", "z", "zy",
];

pub static EN_SYMBOLS: &[&str] = &[
    "aa", "ae", "ah", "ao", "aw", "ay", "b", "ch", "d", "dh", "eh", "er", "ey", "f", "g", "hh",
    "ih", "iy", "jh", "k", "l", "m", "n", "ng", "ow", "oy", "p", "r", "s", "sh", "t", "th", "uh",
    "uw", "V", "w", "y", "z", "zh",
];
