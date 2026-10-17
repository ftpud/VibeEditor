import { describe, expect, it } from "vitest";
import { javaFileType } from "./java-file-type.js";

describe("Java explorer declaration metadata", () => {
  it.each([
    ["public class Example {}", { kind: "class" }],
    ["public abstract class Example extends Base implements Runnable {}", { kind: "class", abstract: true, extends: true, implements: true }],
    ["interface Example extends Parent {}", { kind: "interface", extends: true }],
    ["enum Example implements Runnable { VALUE; }", { kind: "enum", implements: true }],
    ["record Example(int value) implements Runnable {}", { kind: "record", implements: true }],
    ["public @interface Example {}", { kind: "annotation" }],
    ["class Example<T extends Number> {}", { kind: "class" }],
    ["class Example<T extends Number> extends Base<T> {}", { kind: "class", extends: true }],
    ['/* interface Example {} */ @Label("class Example extends Base") class Example {}', { kind: "class" }],
    ['class Other { String text = "interface Example {}"; class Example {} }', undefined],
    ['class Other { String text = """\ninterface Example {}\n"""; } record Example(int value) {}', { kind: "record" }],
    ['// interface Example {}\nclass Example {}', { kind: "class" }]
  ])("classifies %s", (source, expected) => {
    expect(javaFileType(source, "Example")).toEqual(expected);
  });
});
