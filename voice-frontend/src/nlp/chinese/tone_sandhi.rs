use jieba_rs::Jieba;
use once_cell::sync::Lazy;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use super::g2p::finals_with_tone;

fn finals_tone3_for_word(word: &str) -> Vec<String> {
    static CACHE: Lazy<Mutex<HashMap<String, Vec<String>>>> =
        Lazy::new(|| Mutex::new(HashMap::new()));

    if let Some(cached) = CACHE.lock().unwrap().get(word).cloned() {
        return cached;
    }

    let finals = finals_with_tone(word);
    CACHE
        .lock()
        .unwrap()
        .insert(word.to_string(), finals.clone());
    finals
}

/// 必须读轻声的词（从你的 Python 代码搬过来）
static MUST_NEUTRAL_TONE_WORDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    let words = [
        "麻烦", "麻利", "鸳鸯", "高粱", "骨头", "骆驼", "马虎", "首饰", "馒头", "馄饨", "风筝",
        "难为", "队伍", "阔气", "闺女", "门道", "锄头", "铺盖", "铃铛", "铁匠", "钥匙", "里脊",
        "里头", "部分", "那么", "道士", "造化", "迷糊", "连累", "这么", "这个", "运气", "过去",
        "软和", "转悠", "踏实", "跳蚤", "跟头", "趔趄", "财主", "豆腐", "讲究", "记性", "记号",
        "认识", "规矩", "见识", "裁缝", "补丁", "衣裳", "衣服", "衙门", "街坊", "行李", "行当",
        "蛤蟆", "蘑菇", "薄荷", "葫芦", "葡萄", "萝卜", "荸荠", "苗条", "苗头", "苍蝇", "芝麻",
        "舒服", "舒坦", "舌头", "自在", "膏药", "脾气", "脑袋", "脊梁", "能耐", "胳膊", "胭脂",
        "胡萝", "胡琴", "胡同", "聪明", "耽误", "耽搁", "耷拉", "耳朵", "老爷", "老实", "老婆",
        "老头", "老太", "翻腾", "罗嗦", "罐头", "编辑", "结实", "红火", "累赘", "糨糊", "糊涂",
        "精神", "粮食", "簸箕", "篱笆", "算计", "算盘", "答应", "笤帚", "笑语", "笑话", "窟窿",
        "窝囊", "窗户", "稳当", "稀罕", "称呼", "秧歌", "秀气", "秀才", "福气", "祖宗", "砚台",
        "码头", "石榴", "石头", "石匠", "知识", "眼睛", "眯缝", "眨巴", "眉毛", "相声", "盘算",
        "白净", "痢疾", "痛快", "疟疾", "疙瘩", "疏忽", "畜生", "生意", "甘蔗", "琵琶", "琢磨",
        "琉璃", "玻璃", "玫瑰", "玄乎", "狐狸", "状元", "特务", "牲口", "牙碜", "牌楼", "爽快",
        "爱人", "热闹", "烧饼", "烟筒", "烂糊", "点心", "炊帚", "灯笼", "火候", "漂亮", "滑溜",
        "溜达", "温和", "清楚", "消息", "浪头", "活泼", "比方", "正经", "欺负", "模糊", "槟榔",
        "棺材", "棒槌", "棉花", "核桃", "栅栏", "柴火", "架势", "枕头", "枇杷", "机灵", "本事",
        "木头", "木匠", "朋友", "月饼", "月亮", "暖和", "明白", "时候", "新鲜", "故事", "收拾",
        "收成", "提防", "挖苦", "挑剔", "指甲", "指头", "拾掇", "拳头", "拨弄", "招牌", "招呼",
        "抬举", "护士", "折腾", "扫帚", "打量", "打算", "打点", "打扮", "打听", "打发", "扎实",
        "扁担", "戒指", "懒得", "意识", "意思", "情形", "悟性", "怪物", "思量", "怎么", "念头",
        "念叨", "快活", "忙活", "志气", "心思", "得罪", "张罗", "弟兄", "开通", "应酬", "庄稼",
        "干事", "帮手", "帐篷", "希罕", "师父", "师傅", "巴结", "巴掌", "差事", "工夫", "岁数",
        "屁股", "尾巴", "少爷", "小气", "小伙", "将就", "对头", "对付", "寡妇", "家伙", "客气",
        "实在", "官司", "学问", "学生", "字号", "嫁妆", "媳妇", "媒人", "婆家", "娘家", "委屈",
        "姑娘", "姐夫", "妯娌", "妥当", "妖精", "奴才", "女婿", "头发", "太阳", "大爷", "大方",
        "大意", "大夫", "多少", "多么", "外甥", "壮实", "地道", "地方", "在乎", "困难", "嘴巴",
        "嘱咐", "嘟囔", "嘀咕", "喜欢", "喇嘛", "喇叭", "商量", "唾沫", "哑巴", "哈欠", "哆嗦",
        "咳嗽", "和尚", "告诉", "告示", "含糊", "吓唬", "后头", "名字", "名堂", "合同", "吆喝",
        "叫唤", "口袋", "厚道", "厉害", "千斤", "包袱", "包涵", "匀称", "勤快", "动静", "动弹",
        "功夫", "力气", "前头", "刺猬", "刺激", "别扭", "利落", "利索", "利害", "分析", "出息",
        "凑合", "凉快", "冷战", "冤枉", "冒失", "养活", "关系", "先生", "兄弟", "便宜", "使唤",
        "佩服", "作坊", "体面", "位置", "似的", "伙计", "休息", "什么", "人家", "亲戚", "亲家",
        "交情", "云彩", "事情", "买卖", "主意", "丫头", "丧气", "两口", "东西", "东家", "世故",
        "不由", "不在", "下水", "下巴", "上头", "上司", "丈夫", "丈人", "一辈", "那个", "菩萨",
        "父亲", "母亲", "咕噜", "邋遢", "费用", "冤家", "甜头", "介绍", "荒唐", "大人", "泥鳅",
        "幸福", "熟悉", "计划", "扑腾", "蜡烛", "姥爷", "照顾", "喉咙", "吉他", "弄堂", "蚂蚱",
        "凤凰", "拖沓", "寒碜", "糟蹋", "倒腾", "报复", "逻辑", "盘缠", "喽啰", "牢骚", "咖喱",
        "扫把", "惦记",
    ];
    words.into_iter().collect()
});

/// 明确不能轻声的“子”等
static MUST_NOT_NEUTRAL_TONE_WORDS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    let words = [
        "男子", "女子", "分子", "原子", "量子", "莲子", "石子", "瓜子", "电子", "人人", "虎虎",
    ];
    words.into_iter().collect()
});

/// 标点
const PUNC: &str = "：，；。？！“”‘’':,;.?!";

pub struct ToneSandhi {
    jieba: Jieba,
}

pub static TONE_SANDHI: Lazy<ToneSandhi> = Lazy::new(ToneSandhi::new);

impl ToneSandhi {
    pub fn new() -> Self {
        ToneSandhi {
            jieba: Jieba::new(),
        }
    }

    /// 对外入口：给一个词、词性和 finals（每字一个，例如 ["an3","men2"]）
    pub fn modified_tone(&self, word: &str, pos: &str, finals: Vec<String>) -> Vec<String> {
        let finals = self.bu_sandhi(word, finals);
        let finals = self.yi_sandhi(word, finals);
        let finals = self.neutral_sandhi(word, pos, finals);
        let finals = self.three_sandhi(word, finals);
        finals
    }

    /// 对整句/整段的预合并（对应 pre_merge_for_modify）
    /// seg: Vec<(word, pos)>
    pub fn pre_merge_for_modify(&self, seg: Vec<(String, String)>) -> Vec<(String, String)> {
        let seg = self.merge_bu(seg);
        let seg = self.merge_yi(seg);
        let seg = self.merge_reduplication(seg);
        let seg = self.merge_continuous_three_tones(seg);
        let seg = self.merge_continuous_three_tones_2(seg);
        let seg = self.merge_er(seg);
        seg
    }

    fn neutral_sandhi(&self, word: &str, pos: &str, mut finals: Vec<String>) -> Vec<String> {
        let chars: Vec<char> = word.chars().collect();
        let len = chars.len();

        // reduplication words for n. and v. e.g. 奶奶, 试试, 旺旺
        if !word.is_empty()
            && !MUST_NOT_NEUTRAL_TONE_WORDS.contains(word)
            && pos
                .chars()
                .next()
                .map(|c| ['n', 'v', 'a'].contains(&c))
                .unwrap_or(false)
        {
            for j in 1..len {
                if chars[j] == chars[j - 1] {
                    if let Some(f) = finals.get_mut(j) {
                        *f = Self::set_tone(f, '5');
                    }
                }
            }
        }

        // 下面是大 if 的拆分
        if len >= 1 {
            let last = chars[len - 1];

            let cond_yuqici = "吧呢啊呐噻嘛吖嗨呐哦哒额滴哩哟喽啰耶喔诶".contains(last);

            let cond_de_dedi = "的地得".contains(last);

            let cond_men_zi = len > 1
                && "们子".contains(last)
                && (pos == "r" || pos == "n")
                && !MUST_NOT_NEUTRAL_TONE_WORDS.contains(word);

            let cond_shangxiali =
                len > 1 && "上下里".contains(last) && (pos == "s" || pos == "l" || pos == "f");

            let cond_laiqu = if len > 1 {
                let last2 = chars[len - 2];
                "来去".contains(last) && "上下进出回过起开".contains(last2)
            } else {
                false
            };

            if cond_yuqici || cond_de_dedi || cond_men_zi || cond_shangxiali || cond_laiqu {
                if let Some(f) = finals.last_mut() {
                    *f = Self::set_tone(f, '5');
                }
            } else {
                // 个做量词
                let ge_idx = chars.iter().position(|&c| c == '个');
                let ge_cond = if let Some(ge_i) = ge_idx {
                    if ge_i >= 1 {
                        let prev = chars[ge_i - 1];
                        prev.is_ascii_digit() || "几有两半多各整每做是".contains(prev)
                    } else {
                        false
                    }
                } else {
                    false
                };

                if (ge_idx.is_some() && ge_cond) || word == "个" {
                    if let Some(gi) = ge_idx {
                        if let Some(f) = finals.get_mut(gi) {
                            *f = Self::set_tone(f, '5');
                        }
                    }
                } else if MUST_NEUTRAL_TONE_WORDS.contains(word)
                    || (len >= 2 && {
                        let last2: String = chars[len - 2..].iter().collect();
                        MUST_NEUTRAL_TONE_WORDS.contains(last2.as_str())
                    })
                {
                    if let Some(f) = finals.last_mut() {
                        *f = Self::set_tone(f, '5');
                    }
                }
            }
        }

        // 再按 _split_word 拆一下，对子词做 conventional neutral
        let word_list = self.split_word(word);
        if word_list.len() == 2 {
            let first_len = word_list[0].chars().count();
            let mut finals_list = vec![finals[0..first_len].to_vec(), finals[first_len..].to_vec()];
            for i in 0..2 {
                let sub_word = &word_list[i];
                if MUST_NEUTRAL_TONE_WORDS.contains(sub_word.as_str())
                    || (sub_word.chars().count() >= 2 && {
                        let cs: Vec<char> = sub_word.chars().collect();
                        let last2: String = cs[cs.len() - 2..].iter().collect();
                        MUST_NEUTRAL_TONE_WORDS.contains(last2.as_str())
                    })
                {
                    if let Some(f) = finals_list[i].last_mut() {
                        *f = Self::set_tone(f, '5');
                    }
                }
            }
            finals = finals_list.into_iter().flatten().collect();
        }

        finals
    }

    fn bu_sandhi(&self, word: &str, mut finals: Vec<String>) -> Vec<String> {
        let chars: Vec<char> = word.chars().collect();
        let len = chars.len();

        // e.g. 看不懂
        if len == 3 && chars[1] == '不' {
            if let Some(f) = finals.get_mut(1) {
                *f = Self::set_tone(f, '5');
            }
        } else {
            for i in 0..len {
                if chars[i] == '不' && i + 1 < len {
                    if let Some(next) = finals.get(i + 1) {
                        if Self::tone_of(next) == '4' {
                            if let Some(f) = finals.get_mut(i) {
                                *f = Self::set_tone(f, '2'); // 不 + 四声 => bu2
                            }
                        }
                    }
                }
            }
        }
        finals
    }

    fn yi_sandhi(&self, word: &str, mut finals: Vec<String>) -> Vec<String> {
        let chars: Vec<char> = word.chars().collect();
        let len = chars.len();

        // "一" 在数字序列中
        if word.contains('一')
            && word
                .chars()
                .filter(|c| *c != '一')
                .all(|c| c.is_ascii_digit())
        {
            return finals;
        }
        // V + 一 + V 的叠词（看一看）
        if len == 3 && chars[1] == '一' && chars[0] == chars[2] {
            if let Some(f) = finals.get_mut(1) {
                *f = Self::set_tone(f, '5');
            }
            return finals;
        }
        // 第一次、第一百 => 第二个字“一”读一声
        if word.starts_with("第一") {
            if finals.len() >= 2 {
                let f = &mut finals[1];
                *f = Self::set_tone(f, '1');
            }
            return finals;
        }

        // 一般情况：看后一字的声调
        for i in 0..len {
            if chars[i] == '一' && i + 1 < len {
                // 找到后一字的 finals
                if let Some(next) = finals.get(i + 1) {
                    let next_tone = Self::tone_of(next);
                    if next_tone == '4' {
                        if let Some(f) = finals.get_mut(i) {
                            *f = Self::set_tone(f, '2'); // 一 + 四声 => yi2
                        }
                    } else {
                        let next_char = chars[i + 1];
                        if !PUNC.contains(next_char) {
                            if let Some(f) = finals.get_mut(i) {
                                *f = Self::set_tone(f, '4'); // 一 + 非四声 => yi4
                            }
                        }
                    }
                }
            }
        }
        finals
    }

    fn split_word(&self, word: &str) -> Vec<String> {
        // 对应 Python 中的 jieba.cut_for_search + 排序
        let seg: Vec<String> = self
            .jieba
            .cut_for_search(word, false)
            .into_iter()
            .map(|s| s.to_string())
            .collect();

        if seg.is_empty() {
            return vec![word.to_string(), String::new()];
        }

        let mut word_list = seg;
        word_list.sort_by_key(|s| s.chars().count());

        let first_subword = &word_list[0];
        if let Some(first_begin_idx) = word.find(first_subword) {
            if first_begin_idx == 0 {
                let second_subword = word[first_subword.len()..].to_string();
                vec![first_subword.clone(), second_subword]
            } else {
                let second_subword = word[..word.len() - first_subword.len()].to_string();
                vec![second_subword, first_subword.clone()]
            }
        } else {
            vec![word.to_string(), String::new()]
        }
    }

    fn three_sandhi(&self, word: &str, mut finals: Vec<String>) -> Vec<String> {
        let len_chars = word.chars().count();

        if len_chars == 2 && self.all_tone_three(&finals) {
            if let Some(f) = finals.get_mut(0) {
                *f = Self::set_tone(f, '2');
            }
        } else if len_chars == 3 {
            let word_list = self.split_word(word);
            if self.all_tone_three(&finals) {
                let first_len = word_list[0].chars().count();
                if first_len == 2 {
                    // disyllabic + monosyllabic
                    if finals.len() >= 2 {
                        finals[0] = Self::set_tone(&finals[0], '2');
                        finals[1] = Self::set_tone(&finals[1], '2');
                    }
                } else if first_len == 1 {
                    // monosyllabic + disyllabic
                    if finals.len() >= 2 {
                        finals[1] = Self::set_tone(&finals[1], '2');
                    }
                }
            } else {
                let first_len = word_list[0].chars().count();
                if first_len < finals.len() {
                    let mut finals_list =
                        vec![finals[0..first_len].to_vec(), finals[first_len..].to_vec()];

                    for i in 0..finals_list.len() {
                        let sub = &mut finals_list[i];
                        if self.all_tone_three(sub) && sub.len() == 2 {
                            sub[0] = Self::set_tone(&sub[0], '2');
                        } else if i == 1
                            && !self.all_tone_three(sub)
                            && Self::tone_of(&sub[0]) == '3'
                            && Self::tone_of(&finals_list[0].last().unwrap()) == '3'
                        {
                            let last0 = finals_list[0].len() - 1;
                            finals_list[0][last0] = Self::set_tone(&finals_list[0][last0], '2');
                        }
                    }
                    finals = finals_list.into_iter().flatten().collect();
                }
            }
        } else if len_chars == 4 {
            // 成语拆成 2 + 2
            if finals.len() == 4 {
                let (mut first, mut second) = (finals[0..2].to_vec(), finals[2..].to_vec());
                if self.all_tone_three(&first) {
                    first[0] = Self::set_tone(&first[0], '2');
                }
                if self.all_tone_three(&second) {
                    second[0] = Self::set_tone(&second[0], '2');
                }
                finals = [first, second].concat();
            }
        }

        finals
    }

    fn all_tone_three(&self, finals: &[String]) -> bool {
        finals.iter().all(|x| Self::tone_of(x) == '3')
    }

    // merge "不" 和后面的词
    fn merge_bu(&self, seg: Vec<(String, String)>) -> Vec<(String, String)> {
        let mut new_seg = Vec::new();
        let mut last_word = String::new();

        for (word, pos) in seg.into_iter() {
            let mut w = word.clone();
            if last_word == "不" {
                w = format!("{}{}", last_word, word);
            }
            if w != "不" {
                new_seg.push((w.clone(), pos));
            }
            last_word = w;
        }

        if last_word == "不" {
            new_seg.push((last_word, "d".to_string()));
        }

        new_seg
    }

    /// 合并“一”和左右重叠词 / 后面词
    fn merge_yi(&self, seg: Vec<(String, String)>) -> Vec<(String, String)> {
        let mut new_seg: Vec<(String, String)> = Vec::new();
        let mut i = 0usize;

        // function 1: V + 一 + V
        while i < seg.len() {
            let (ref word, ref pos) = seg[i];
            if i >= 1
                && i + 1 < seg.len()
                && word == "一"
                && seg[i - 1].0 == seg[i + 1].0
                && seg[i - 1].1 == "v"
            {
                if let Some(last) = new_seg.last_mut() {
                    last.0 = format!("{}一{}", last.0, last.0);
                }
                i += 2;
            } else {
                if i >= 2 && seg[i - 1].0 == "一" && seg[i - 2].0 == *word && pos == "v" {
                    // 已经合并过，看 Python 的逻辑，本次跳过
                    i += 1;
                    continue;
                } else {
                    new_seg.push((word.clone(), pos.clone()));
                    i += 1;
                }
            }
        }

        // function 2: 合并单独“一”和后面的词
        let mut seg2: Vec<(String, String)> =
            new_seg.into_iter().filter(|(w, _)| !w.is_empty()).collect();
        let mut result: Vec<(String, String)> = Vec::new();

        for (word, pos) in seg2.drain(..) {
            if let Some(last) = result.last_mut() {
                if last.0 == "一" {
                    last.0 = format!("{}{}", last.0, word);
                    continue;
                }
            }
            result.push((word, pos));
        }

        result
    }

    fn merge_continuous_three_tones(&self, seg: Vec<(String, String)>) -> Vec<(String, String)> {
        let sub_finals_list: Vec<Vec<String>> = seg
            .iter()
            .map(|(word, _)| finals_tone3_for_word(word))
            .collect();

        let mut new_seg: Vec<(String, String)> = Vec::new();
        let mut merge_last = vec![false; seg.len()];

        for (i, (word, pos)) in seg.into_iter().enumerate() {
            if i >= 1
                && self.all_tone_three(sub_finals_list.get(i - 1).unwrap_or(&Vec::new()))
                && self.all_tone_three(sub_finals_list.get(i).unwrap_or(&Vec::new()))
                && !merge_last[i - 1]
            {
                if let Some(last) = new_seg.last_mut() {
                    if !self.is_reduplication(&last.0)
                        && last.0.chars().count() + word.chars().count() <= 3
                    {
                        last.0.push_str(&word);
                        merge_last[i] = true;
                    } else {
                        new_seg.push((word, pos));
                    }
                } else {
                    new_seg.push((word, pos));
                }
            } else {
                new_seg.push((word, pos));
            }
        }

        new_seg
    }

    fn is_reduplication(&self, word: &str) -> bool {
        let chars: Vec<char> = word.chars().collect();
        chars.len() == 2 && chars[0] == chars[1]
    }

    fn merge_continuous_three_tones_2(&self, seg: Vec<(String, String)>) -> Vec<(String, String)> {
        let sub_finals_list: Vec<Vec<String>> = seg
            .iter()
            .map(|(word, _)| finals_tone3_for_word(word))
            .collect();

        let mut new_seg: Vec<(String, String)> = Vec::new();
        let mut merge_last = vec![false; seg.len()];

        for (i, (word, pos)) in seg.into_iter().enumerate() {
            if i >= 1
                && sub_finals_list
                    .get(i - 1)
                    .and_then(|v| v.last().map(|s| Self::tone_of(s)))
                    .unwrap_or('0')
                    == '3'
                && sub_finals_list
                    .get(i)
                    .and_then(|v| v.first().map(|s| Self::tone_of(s)))
                    .unwrap_or('0')
                    == '3'
                && !merge_last[i - 1]
            {
                if let Some(last) = new_seg.last_mut() {
                    if !self.is_reduplication(&last.0)
                        && last.0.chars().count() + word.chars().count() <= 3
                    {
                        last.0.push_str(&word);
                        merge_last[i] = true;
                    } else {
                        new_seg.push((word, pos));
                    }
                } else {
                    new_seg.push((word, pos));
                }
            } else {
                new_seg.push((word, pos));
            }
        }

        new_seg
    }

    fn merge_er(&self, seg: Vec<(String, String)>) -> Vec<(String, String)> {
        let mut new_seg: Vec<(String, String)> = Vec::new();

        for (i, (word, pos)) in seg.into_iter().enumerate() {
            if i >= 1 && word == "儿" && new_seg.last().map(|(w, _)| w != "#").unwrap_or(false) {
                if let Some(last) = new_seg.last_mut() {
                    last.0.push_str("儿");
                }
            } else {
                new_seg.push((word, pos));
            }
        }
        new_seg
    }

    fn merge_reduplication(&self, seg: Vec<(String, String)>) -> Vec<(String, String)> {
        let mut new_seg: Vec<(String, String)> = Vec::new();

        for (word, pos) in seg.into_iter() {
            if let Some(last) = new_seg.last_mut() {
                if last.0 == word {
                    last.0.push_str(&word);
                    continue;
                }
            }
            new_seg.push((word, pos));
        }

        new_seg
    }

    // 工具函数：取一个 finals 字串末尾的数字调号
    fn tone_of(syllable: &str) -> char {
        syllable.chars().last().unwrap_or('5')
    }

    fn set_tone(syllable: &str, tone: char) -> String {
        let mut chars: Vec<char> = syllable.chars().collect();
        if let Some(last) = chars.last_mut() {
            if last.is_ascii_digit() {
                *last = tone;
                return chars.iter().collect();
            }
        }
        // 如果没有数字，就直接加一个
        format!("{}{}", syllable, tone)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bu_before_fourth_tone_becomes_second() {
        let sandhi = ToneSandhi::new();
        let finals = vec!["u4".to_string(), "ui4".to_string()];
        let result = sandhi.modified_tone("不对", "v", finals);
        assert_eq!(result, vec!["u2".to_string(), "ui4".to_string()]);
    }

    #[test]
    fn third_tone_pair_applies_sandhi() {
        let sandhi = ToneSandhi::new();
        let finals = vec!["i3".to_string(), "ao3".to_string()];
        let result = sandhi.modified_tone("你好", "v", finals);
        assert_eq!(result, vec!["i2".to_string(), "ao3".to_string()]);
    }
}
