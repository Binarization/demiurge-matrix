use once_cell::sync::Lazy;
use regex::Regex;

static NUMBER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\d+(?:\.\d+)?").expect("valid number regex"));

const DIGITS: [&str; 10] = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const UNITS: [&str; 4] = ["", "十", "百", "千"];
const SECTION_UNITS: [&str; 5] = ["", "万", "亿", "兆", "京"];

pub fn replace_numbers(text: &str) -> String {
    NUMBER_RE
        .replace_all(text, |caps: &regex::Captures| an2cn(&caps[0]))
        .into_owned()
}

fn an2cn(number: &str) -> String {
    if number.is_empty() {
        return String::new();
    }
    if number == "0" {
        return DIGITS[0].to_string();
    }
    let mut parts = number.split('.');
    let int_part = parts.next().unwrap();
    let frac_part = parts.next();

    let mut result = if let Ok(int) = int_part.parse::<i128>() {
        convert_integer(int)
    } else {
        String::from(int_part)
    };

    if let Some(frac) = frac_part {
        if !frac.is_empty() {
            result.push('点');
            for ch in frac.chars() {
                if let Some(d) = ch.to_digit(10) {
                    result.push_str(DIGITS[d as usize]);
                } else {
                    result.push(ch);
                }
            }
        }
    }

    result
}

fn convert_integer(mut value: i128) -> String {
    if value == 0 {
        return DIGITS[0].to_string();
    }
    let mut result = String::new();
    if value < 0 {
        result.push('负');
        value = -value;
    }

    let mut section_index = 0usize;
    let mut need_zero = false;

    while value > 0 {
        let section = (value % 10_000) as i32;
        if section != 0 {
            let section_str = convert_section(section);
            if need_zero && !result.starts_with('零') {
                result.insert_str(0, "零");
            }
            let unit = SECTION_UNITS
                .get(section_index)
                .copied()
                .unwrap_or_default();
            let mut chunk = section_str;
            chunk.push_str(unit);
            result.insert_str(0, &chunk);
            need_zero = section < 1000 && value >= 10_000;
        } else if !result.is_empty() {
            need_zero = true;
        }
        value /= 10_000;
        section_index += 1;
    }

    if result.starts_with("一十") && result.len() > 2 {
        result = result.replacen("一十", "十", 1);
    }

    result
}

fn convert_section(mut section: i32) -> String {
    let mut words = String::new();
    let mut unit_pos = 0usize;
    let mut zero = true;

    while section > 0 {
        let digit = (section % 10) as usize;
        if digit == 0 {
            if !zero {
                zero = true;
                words.insert_str(0, DIGITS[0]);
            }
        } else {
            zero = false;
            let mut chunk = String::from(DIGITS[digit]);
            chunk.push_str(UNITS[unit_pos]);
            words.insert_str(0, &chunk);
        }
        unit_pos += 1;
        section /= 10;
    }

    words.trim_end_matches('零').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_arabic_numbers_with_chinese() {
        assert_eq!(replace_numbers("我有123个苹果"), "我有一百二十三个苹果");
        assert_eq!(replace_numbers("价格是0.5元"), "价格是零点五元");
    }
}
