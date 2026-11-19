// Markdown inputs and the inline shape each must give, shared by the web test (remark) and the
// Android app test (marked) so both draw the same result. The shape writes a link as `[label](url)`,
// strong as `**x**`, emphasis as `*x*`, and everything else as its text with each `*` written `\*`
// (so a mark left unparsed differs from one that made strong).
export const CJK_EMPHASIS_CASES: ReadonlyArray<readonly [markdown: string, shape: string]> = [
  // A closing mark touching Korean or CJK text
  ["**중요**는", "**중요**는"],
  ["**굵게**(괄호)", "**굵게**(괄호)"],
  ["*기울임*이다", "*기울임*이다"],
  ["이것은**강조**입니다", "이것은**강조**입니다"],
  ["**“인용”**이라고 했다", "**“인용”**이라고 했다"],
  ["**中文**，然后", "**中文**，然后"],
  ["**注意：**请看", "**注意：**请看"],
  // English text keeps CommonMark's rules
  ["**bold** text", "**bold** text"],
  ["a**b**c", "a**b**c"],
  ["*em* and **strong**.", "*em* and **strong**."],
  ["snake_case_word and foo__bar__baz", "snake_case_word and foo__bar__baz"],
  ["2 * 3 * 4", "2 \\* 3 \\* 4"],
  ["**bold**text", "**bold**text"],
  ["_a_b", "_a_b"],
  // With a bare URL
  ["**https://x.com**는", "**[https://x.com](https://x.com)**는"],
  [
    "**www.example.com**(일부만 보고 중단)이",
    "**[www.example.com](http://www.example.com)**(일부만 보고 중단)이",
  ],
  ["*https://x.com*는", "*[https://x.com](https://x.com)*는"],
  ["**https://x.com/a/b**는", "**[https://x.com/a/b](https://x.com/a/b)**는"],
  ["www.example.com(일부만)", "[www.example.com](http://www.example.com)(일부만)"],
];
