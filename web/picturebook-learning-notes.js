// Editorial reading help for the bundled English edition. These are assistance
// preferences and contextual explanations, never claims about a child's mastery.
const glossary = (source) =>
  Object.fromEntries(
    source
      .split("|")
      .filter(Boolean)
      .map((item) => {
        const at = item.indexOf("=");
        return [item.slice(0, at), item.slice(at + 1)];
      }),
  );
const common = glossary(
  "prince's=小王子的|earth's=地球的|king's=国王的|gentleman's=那位先生的|sheep's=小羊的|critic's=评论者的|boa's=蟒蛇的|one's=一个人的|someone's=某个人的|he's=他是；他已经|she's=她是；她已经|eyes closed=闭着眼睛|closed eyes=闭着的眼睛|close to=靠近|sat down=坐下|found=发现；找到|took=拿；带走|taken=拿走了|gave=给了|given=给出的|came=来了|gone=离开了|went=去了|seen=看见过|knew=知道|known=已知的|thought=想；想法|brought=带来|bought=买了|made=做了|told=告诉了|said=说了|heard=听到了|stood=站着|sat=坐下|saw=看见了|felt=觉得|kept=保持；保留|held=拿着|drew=画了|drawn=画过|grew=变得；生长了|understood=明白了|became=变得|began=开始了|begun=开始了|meant=意思是|shut=关上|set=放置；设定|replied=回答|answered=回答|asked=问|added=补充说|continued=继续|repeated=重复说|demanded=追问|exclaimed=大声说|murmured=小声说|remarked=说道|inquired=询问|insisted=坚持问|interrupted=打断|sighed=叹气|confessed=承认|astonished=惊讶的|puzzled=困惑的|bewildered=不知所措的|embarrassed=不好意思的|abashed=窘迫的|amazed=惊讶的|scarcely=几乎不|merely=只是|nevertheless=尽管如此|therefore=因此|indeed=的确|perhaps=也许|certainly=当然|suddenly=突然|quietly=轻声地|gently=轻轻地|solemnly=郑重地|curious=好奇的|curiously=好奇地|extraordinary=不寻常的|ordinary=普通的|precious=珍贵的|importance=重要性|important=重要的|glad=高兴的|delighted=高兴的|reasonable=合乎道理的|departure=离开；启程|journey=旅程|discovered=发现了|remember=记得|remembered=想起|forget=忘记|forgotten=忘记了|forgot=忘记了|explanation=解释|explanations=解释|underneath=在……下面|toward=朝着|towards=朝着|although=虽然|instead=反而；代替|rather=相当；宁可|quite=很；完全|enough=足够的|terrible=可怕的|terribly=非常|frightened=害怕的|frightful=可怕的|happy=快乐的|unhappy=不开心的|sorrow=悲伤|sorrows=悲伤|grief=悲伤|tears=眼泪|crying=哭泣|laughed=笑了|laughing=笑着|laughter=笑声|thirsty=口渴的|hungry=饥饿的|tired=疲惫的|morning=早晨|evening=傍晚|night=夜晚|daybreak=黎明|sunrise=日出|sunset=日落|sunsets=日落|forehead=额头|temples=太阳穴|lips=嘴唇|ankle=脚踝|knees=膝盖|shoulders=肩膀|scarf=围巾|muffler=围巾|golden=金色的|tiny=很小的|globe=玻璃罩|grown-up=大人|grown-ups=大人们|figures=数字|came to understand=渐渐明白|came to know=逐渐了解|for a long time=很长一段时间|used to=过去常常|took him in my arms=把他抱进怀里|in my arms=在我怀里|in his arms=在他怀里|on earth=究竟；到底|bit by bit=一点一点地|at once=立刻|at last=终于|at first=起初|as if=仿佛|as though=好像|for a while=一会儿|once more=再一次|all at once=突然|all the same=尽管如此|just the same=仍然；照样|in spite of=尽管|of course=当然|no longer=不再|a great deal=很多|a great many=许多|in order to=为了|so that=以便；因此|one another=彼此|each other=互相|as for=至于|as soon as=一……就|on the contrary=正相反|in consequence=因此|nothing but=只不过是|no more than=只不过|a matter of=关于……的事情|matters of consequence=重要的事情|of consequence=重要的|come back=回来|came back=回来了|go away=离开|went away=离开了|set out=出发|taking his leave=告别离开|took his leave=告别离开|came upon=偶然遇到|take care of=照料|look after=照顾|looking for=寻找|look for=寻找|looked for=寻找过|looked at=看着|look at=看|look up=抬头看|gave up=放弃了|go on=继续|went on=继续说|come from=来自|came from=来自|got lost=迷路了|get lost=迷路|get rid of=除掉|pull up=拔掉|pulled up=拔掉了|looked like=看起来像|turned around=转过身|side by side=并排|once upon a time=从前|in the world=世界上|the whole world=全世界|at a glance=一眼看出|from time to time=时不时|i'm=我是|i'll=我会|i've=我已经|i'd=我会；我曾|can't=不能|couldn't=不能|don't=不；不要|doesn't=不|didn't=没有|won't=不会|wouldn't=不会|isn't=不是|wasn't=不是|aren't=不是|haven't=还没有|hadn't=还没有|there's=那里有|there'll=那里将有|that's=那就是|it's=它是；它已经|you're=你是|you've=你已经|you'll=你会|we're=我们是|we'll=我们会|let's=让我们|what's=什么……|who's=谁是",
);
export const chapterGlossaries = {
  3: glossary(
    "work out=弄明白|pieced=拼凑起来|pieced his story together=拼凑出他的故事|gradually=渐渐地|odd=零碎；奇怪的|caught sight of=看见|proud=自豪的|modestly=谦虚地|tinkling=清脆悦耳的|annoying=令人烦恼的|take my troubles seriously=认真对待我的困难|dawned on me=我忽然明白|clue=线索|mysterious=神秘的|appearance=出现|nodded=点头|lost in thought=陷入沉思|examined=仔细查看|treasure=宝贝|intrigued=引起好奇的|allusion=暗示；提及|pondered=思考了|crate=木箱|stake=木桩|tie him up=把它拴住|wander=四处走动|burst out laughing=突然大笑|wistfully=惆怅地|straight ahead=一直往前|airplane=飞机|feel=跌落（此处原文拼写）",
  ),
  4: glossary(
    "scarcely=几乎不|jupiter=木星|mars=火星|venus=金星|astronomer=天文学家|astronomical=天文学的|asteroid=小行星|b 612=B612小行星|turkish=土耳其的|congress=大会|demonstration=演示；报告|costume=服装|dictator=独裁者|subjects=臣民|under pain of death=违者会被处死|european=欧洲的|reputation=名声|elegance=优雅|essential=重要的|collect=收集|butterflies=蝴蝶|demand=要求|weigh=称重；有多重|rosy=玫瑰红色的|brick=砖|geraniums=天竺葵|doves=鸽子|roof=屋顶|francs=法郎（旧货币）|proof=证据|existed=曾存在|charming=可爱的|shrug=耸肩|convinced=信服的|forbearance=宽容；忍耐|indifference=不在意|fairy-tales=童话|fair-to- middling=马马虎虎|grief=悲伤|carelessly=粗心地|portraits=肖像|resemblance=相似之处|subject=所画的人物|fumble=笨拙地尝试|middling=一般的|through=透过",
  ),
  5: glossary(
    "departure=离开|catastrophe=灾难|abruptly=突然地|seized=被……抓住|grave=重大的|doubt=疑问|bushes=灌木丛|castles=城堡|herd=一群（动物）|one on top of the other=一个叠在另一个上面|self-evident=不言自明的|obliged=不得不|mental=思考的|assistance=帮助|seeds=种子|invisible=看不见的|desire=愿望|timidly=胆怯地|sprig=小枝|inoffensively=无害地|sprout=幼芽|radish=萝卜|rose-bush=玫瑰丛|rose-bushes=玫瑰丛|destroy=除掉|recognizes=认出|soil=土壤|infested=遍布有害东西的|roots=树根|split=劈裂|discipline=自律；规律|toilet=清洁整理|distinguished=分辨出来|resemble=长得像|tedious=乏味的|putting off=推迟|neglected=忽视了|moralist=说教的人|considerable=相当大的|reserve=克制；含蓄|skirting=绕开|inspiring=鼓舞人的|urgent=紧急的|necessity=必要性|baobabs=猴面包树|baobab=猴面包树",
  ),
  6: glossary(
    "entertainment=消遣|pleasure=乐趣|fond of=喜欢|noon=正午|setting=落下|france=法国|united states of america=美国|unfortunately=不幸的是|twilight=暮色|forty-four=四十四|chair=椅子|move your chair=挪动你的椅子|a few steps=几步",
  ),
  7: glossary(
    "revealed=透露了|meditation=深思|in its reach=够得着的|unscrew=拧开|bolt=螺栓|stuck=卡住的|breakdown=故障|let go of=放下；不再追问|spite=恶意|resentfulness=愤愤不平|creatures=生物|naïve=天真的|reassure=安慰；使安心|weapons=武器|knock it out=把它敲下来|hammer=锤子|thunderstruck=惊呆的|engine-grease=发动机油污|relentlessly=不停地|confuse=混淆|tossed=甩动|curls=卷发|breeze=微风|red-faced=红脸的|gentleman=先生|mushroom=蘑菇（这里是比喻）|swell up with pride=骄傲得膨胀|rage=愤怒|warfare=斗争|sums=算术；数字|blossom=花朵|darkened=变暗了|choked=哽住|sobbing=抽泣|comforted=得到安慰|muzzle=给羊戴的嘴套|railing=围栏|awkward=不知所措的|blundering=笨拙的|land of tears=悲伤的内心世界",
  ),
  8: glossary(
    "ring=一圈|petals=花瓣|faded=凋谢了|sprout=幼芽|shrub=小灌木|bud=花苞|miraculous=奇妙的|apparition=出现的美丽事物|emerge=出现|preparations=准备|shelter=庇护处|chamber=小房间|rumpled=皱巴巴的|poppies=罂粟花|radiance=光彩|coquettish=爱俏的|adornment=装扮|painstaking=精心的|precision=细致准确|disarranged=凌乱的|restrain=抑制|admiration=赞叹|modest=谦虚的|moving=动人的|exciting=令人激动的|sprinkling-can=洒水壶|fresh water=清水|tended=照料|torment=折磨|vanity=虚荣|clows=爪子（原文拼写）|claws=爪子|weeds=杂草|weed=杂草|horror=恐惧|draughts=穿堂风|screen=挡风屏|complex=复杂的|caught=被发现|on the verge of=差一点就……|untruth=不实的话|in the wrong=处于理亏的一方|remorse=内疚|inseparable=分不开的|confided=吐露心事|fragrance=香气|perfumed=使充满香气|grace=优雅|tenderness=温柔|pity=怜爱|confidences=心里话|deeds=行动|affection=爱意|stratagems=小计谋|inconsistent=言行不一的|one by one=一个接一个地",
  ),
  9: glossary(
    "escape=离开|took advantage of=利用了|migration=迁徙|flock=鸟群|departure=启程|volcanoes=火山|active=活的；会喷发的|extinct=死的；不再喷发的|eruptions=喷发|chimney=烟囱|steadily=平稳地|obviously=显然|dejection=沮丧|shoots=嫩芽|familiar=熟悉的|precious=珍贵的|forgiveness=原谅|reproaches=责备|held arrested in midair=举到半空却停住了|endure=忍受|presence=在场；出现|caterpillars=毛毛虫|acquainted=认识了|butterflies=蝴蝶|call upon=拜访|linger=迟迟不走|naively=天真地|proud=骄傲的",
  ),
  10: glossary(
    "neighbourhood=附近|inhabited=有人居住的|clad=穿着|royal=王室的|purple=紫色|ermine=白鼬皮|throne=王座|majestic=威严的|subject=臣民|subjects=臣民|approach=走近|consumingly=非常|crammed=挤满的|obstructed=被挡住的|robe=长袍|upright=笔直地|yawned=打哈欠|yawn=打哈欠|etiquette=礼仪|monarch=君主|forbid=禁止|curiosity=好奇|spluttered=结结巴巴地说|vexed=恼火的|fundamentally=根本上|authority=权威|tolerated=容忍|disobedience=不服从|absolute=绝对的|general=将军|timid=胆怯的|inquiry=询问|mantle=披风|sire=陛下|hastened=赶紧|simplicity=简单；直率|universal=无所不包的|insubordination=违抗|marvel at=惊叹|forsaken=离弃了|plucked up his courage=鼓起勇气|favour=请求；帮助|tragic=悲剧的|drama=戏剧|carry out=执行|duty=责任|revolution=反抗|obedience=服从|favourable=合适的|almanac=历书|bulky=厚重的|minister=大臣|justice=司法；公正|judge=判断；审判|carriage=马车|wisdom=智慧|condemn=判罪|pardon=赦免|thriftily=节省地|majesty=陛下|promptly=立即|ambassador=大使|forty-four=四十四|seventy-two=七十二",
  ),
  11: glossary(
    "conceited=自负的|admirer=崇拜者|admirers=崇拜者|afar=远处|salutes=致意|salute=致意|acclaim=喝彩|entertaining=有趣的|monotony=单调|praise=赞美|admire=赞赏|handsomest=最英俊的|best-dressed=衣着最讲究的|richest=最富有的|shrugging=耸了耸|clapped=拍手了|clap=拍手|game's=游戏的|what does that mean=那是什么意思",
  ),
  12: glossary(
    "tippler=饮酒的人|plunged=使陷入|dejection=沮丧|settled down=坐定|collection=一堆；一批|empty=空的|full=装满的|lugubrious=悲伤的|ashamed=羞愧的|hanging his head=垂下头|impregnable=无法打破的|silence=沉默|shut himself up=封闭自己",
  ),
  13: glossary(
    "occupied=忙碌的|cigarette=香烟|gone out=熄灭了|concerned=关注；忙于|balderdash=无聊的废话|disturbed=被打扰了|giddy=冒失的|goose=鹅|resounded=回响|addition=加法|rheumatism=风湿病|loafing=闲逛|glittering=闪闪发亮的|flies=苍蝇|bees=蜜蜂|idle dreaming=空想|accurate=准确的|own=拥有|reign over=统治|retorted=反驳说|peevishly=不耐烦地|diamond=钻石|island=岛屿|patent=专利|administer=管理|recount=重新数|silk=丝绸|pluck=摘下|heaven=天空|drawer=抽屉|key=钥匙|poetic=像诗一样的|five-hundred-and-one=五百零一|six-hundred-twenty-two=六百二十二|seven-hundred-thirty-one=七百三十一|fifty-four=五十四|twenty-two=二十二|twenty-eight=二十八|twenty-six=二十六|thirty-one=三十一|five-hundred=五百|and-one=零一|six-hundred-twenty=六百二十|seven- hundred-thirty-one=七百三十一|million=百万|millions=数百万|thousand=千|hundred=百",
  ),
  14: glossary(
    "lamplighter=点灯人|lamplighters=点灯人|absurd=荒唐的|puts out=熄灭|put out=熄灭了|lighted=点亮了|occupation=工作|respectfully=恭敬地|orders=命令|mopped=擦了擦|handkerchief=手帕|decorated=装饰着的|red squares=红色方格|relaxation=休息|tragedy=悲剧；不幸|rapidly=迅速地|repose=休息|faithful=忠实的|strides=大步|sunshine=阳光|scorned=被轻视的|blest=有福气的|twenty-four=二十四|makes a complete turn=自转一圈",
  ),
  15: glossary(
    "voluminous=大部头的|explorer=探险家|explorers=探险家们|panted=喘气|geographer=地理学家|scholar=学者|location=位置|stately=宏伟的|disappointed=失望的|loafing about=闲逛|study=书房|recall=回忆|recollections=回忆|moral character=品行|intoxicated=喝醉的|see double=看东西有重影|discovery=发现|furnish=提供|proofs=证据|register=登记簿|recitals=叙述|in ink=用墨水|expectantly=期待地|ephemeral=短暂的；易消逝的|eternal=永恒的|old-fashioned=过时的|regret=后悔|reputation=声誉|extinct=不再喷发的|active=会喷发的|explorer's=探险家的",
  ),
  16: glossary(
    "ordinary=普通的|electricity=电力|continents=大陆|veritable=名副其实的|army=大群|regulated=有规律安排的|ballet=芭蕾舞|opera=歌剧|new zealand=新西兰|australia=澳大利亚|siberia=西伯利亚|russia=俄罗斯|indies=印度地区（书中旧称）|africa=非洲|europe=欧洲|south america=南美洲|north america=北美洲|north pole=北极|south pole=南极|colleague=同事|toil=辛劳|twice a year=一年两次|seven-and-a-half=七又二分之一|three-hundred-eleven=三百一十一|four-hundred-sixty-two=四百六十二",
  ),
  17: glossary(
    "play the wit=卖弄聪明|altogether=完全|honest=诚实的|occupy=占据|billion=十亿|inhabitants=居民|assembly=集会|humanity=全人类|pilled=堆在一起（原文拼写）|islet=小岛|pacific=太平洋|calculations=计算|adore=喜欢|confidence=信任|coil=盘成圈的东西|moonlight=月光|courteously=有礼貌地|alight=发亮的|granite=花岗岩|twined=缠绕了|bracelet=手镯|whomever=无论谁|whence=从何处|innocent=纯真的|homesick=想家的|riddles=谜语",
  ),
  18: glossary(
    "petals=花瓣|of no account=不起眼的|caravan=商队|existence=存在|roots=根|blows them away=把他们吹走|once=曾经",
  ),
  19: glossary(
    "foot-stool=脚凳|peaks=山峰|needles=针|echo=回声|save=除了|queer=奇怪的|harsh=严酷的|forbidding=令人望而生畏的|imagination=想象力|repeat=重复|good morning=早上好|who are you=你是谁|all alone=孤身一人|at one glance=一眼望去",
  ),
  20: glossary(
    "abodes=住处|a-bloom=盛开着|thunderstruck=惊呆的|overcome=被……压倒|universe=宇宙|alike=相像的|annoyed=恼火的|dreadfully=厉害地|pretend=假装|nursing her back to life=把她照料得恢复生机|humble=使谦卑|reflections=思索|common=普通的|lay down=躺下|five thousand=五千",
  ),
  21: glossary(
    "apple tree=苹果树|politely=有礼貌地|tame=驯养；建立联系|tamed=建立了联系|establish ties=建立联系|neglected=被忽视的|perplexed=困惑的|monotonous=单调的|in consequence=因此|burrow=洞穴|grain-fields=麦田|yonder=那边|wheat=小麦|grain=麦子|misunderstandings=误解|out of the corner of my eye=用眼角的余光|patient=有耐心的|rites=仪式；约定的习惯|rite=仪式；约定的习惯|observe=遵守|vineyards=葡萄园|vacation=假期|departure=离开|passerby=过路人|grumbled=抱怨|boasted=夸耀|sheltered=遮挡保护|essential=重要的|invisible=看不见的|responsible=负有责任的|forever=永远|wasted=花费了（这里指投入时间）",
  ),
  22: glossary(
    "railway=铁路|switchman=铁路扳道工|sort out=分配；安排|travellers=旅客|bundles=一批批的人|brilliantly=明亮地|express=快车|cabin=小屋|roar=轰鸣|thunder=雷声|locomotive engineer=火车司机|opposite direction=相反的方向|exchange=互换|satisfied=满意的|pursuing=追赶|flattening=压平；贴紧|window-panes=窗玻璃|rag doll=布娃娃|lucky=幸运的|switchman's=扳道工的",
  ),
  23: glossary(
    "merchant=商人|pills=药丸|pill=药丸|quench thirst=解渴|quench=消除|swallow=吞下|tremendous=巨大的|computations=计算|experts=专家|fifty-three=五十三|at my leisure=悠闲地|spring=泉水|fresh water=清泉水",
  ),
  24: glossary(
    "supply=供应；储备|memories=回忆|succeeded=成功了|spring=泉水|at my leisure=悠闲地|reasoning=推理；想法|steadily=定定地|weariness=疲倦|at random=随意地|immensity=辽阔无边|trudged=艰难地走|feverish=发热的|reeling=翻腾的|cross-examine=反复盘问|ridges=沙脊|dune=沙丘|throbs=悸动|gleams=闪烁|radiation=光辉|legend=传说|buried=埋藏着的|enchantment=魔力|depths=深处|dropped off the sleep=睡着了（原文措辞）|fragile=脆弱的|forehead=额头|locks=一绺绺头发|shell=外壳|suspicion=一丝|loyalty=忠诚|flame=火焰|extinguished=熄灭的|puff=一阵",
  ),
  25: glossary(
    "mere=仅仅是|dug=挖出的|pulley=滑轮|moaned=发出低沉的响声|weathervane=风向标|wakened=唤醒了|hoisted=提起了|achievement=成果|shimmer=闪光|trembling=颤动的|festival treat=节日里的美食|nourishment=营养；食物|sweetness=甘甜|midnight mass=午夜弥撒|radiance=光彩|promise=承诺|muzzle=给羊戴的嘴套|rough drafts=草图|cabbages=卷心菜|descent=降落|anniversary=周年纪念日|flushed=脸红了|hesitancy=犹豫|strolling=慢慢走|inhabited=有人居住的|reassured=安心的|weeping=哭泣|run the risk=冒风险",
  ),
  26: glossary(
    "ruin=废墟|dangling=悬垂着|poison=毒液|suffer=受苦|asunder=碎裂|revolver=左轮手枪|spray=水花|metallic=金属般的|loosened=松开了|moistened=弄湿了|temples=太阳穴|gravely=认真地|reviving=恢复精神|irreparable=无法挽回的|spring=泉水|plea=恳求|meeting-place=约定见面的地方|wealth=财富|comforted=得到安慰|soothes=抚慰|content=满足的|shabby trick=不厚道的玩笑|malicious=有恶意的|resolute=坚定的|abandoned=被丢弃的|discouraged=泄气的|rusty=生锈的|hesitated=犹豫了|motionless=一动不动的|feel=倒下（此处原文拼写）|a-bloom=盛开着|sheep's=羊的",
  ),
  27: glossary(
    "companions=同伴|content=满意的|comforted=平复了一些|entirely=完全地|muzzle=给羊戴的嘴套|leather strap=皮带|strap=带子|fasten=系牢|absent-minded=心不在焉的|mystery=谜团|landscape=风景|impress=使留下深刻印象|recognize=认出|in case=假如|refuses=拒绝|comfort=安慰|send me word=告诉我消息",
  ),
};
export function chapterLearningNotes(chapter, text = "") {
  const result = { ...common, ...chapterGlossaries[chapter] };
  // Same spelling, distinct source contexts. Never change the shared dictionary.
  result.well = /\b(?:a|the|this|that|our) well\b|\bwells\b/i.test(text)
    ? "水井"
    : "好；充分地";
  result.can = /sprinkling-can/i.test(text) ? "洒水壶" : "能；可以";
  if (chapter === 26 && /light metallic sound/.test(text))
    result.light = "轻微的";
  if (chapter === 19 && /save peaks/.test(text)) result.save = "除了";
  if (chapter === 25 && /as i gave it/.test(text.toLowerCase()))
    result.it = "那张嘴套草图";
  return result;
}
