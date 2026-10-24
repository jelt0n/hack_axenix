# Проверенная база Java (#7)

Корпус исполняется на JDK 21 с JavaParser 3.27.1. Технический документ организаторов
не предоставлен, поэтому полный обязательный перечень типов и реализаций неизвестен.
Матрица описывает конкретные проверенные примеры, а не всю Java или API.

| Область | Проверенный пример | Файл корпуса |
| --- | --- | --- |
| Объявления | interface, abstract/base class, implements/extends, поля private/final/static, вложенный static class, конструкторы и перегрузки, this(...), super(...) | `declarations`, `caught` |
| Выбор | Метод и конструктор с телом доступны отдельно; объявления без тела сохраняются | `declarations`, браузер |
| Типы и выражения | byte/short/int/long/float/double/char/boolean, их обёртки, int[], арифметика, логика, сравнения, cast, autoboxing | `primitives` |
| java.lang | Object, String, StringBuilder, Math.abs, Integer.parseInt, Character/Boolean и числовые обёртки | `primitives` |
| Консоль и UTF-8 | System.in через Scanner(StandardCharsets.UTF_8), out/err, Formatter, printf, String.format, Locale.ROOT, кириллица во входе и обоих потоках | `console` |
| Интерфейсы коллекций | Collection/Iterable, List/Set/Map, Iterator | `collections` |
| Реализации коллекций | ArrayList, LinkedList, HashSet, LinkedHashSet, TreeSet, HashMap, LinkedHashMap, TreeMap | `collections` |
| Утилиты | Arrays.sort/toString, Collections.sort, Comparator.naturalOrder, Optional.of/orElse, List.of/Set.of/Map.of | `collections` |
| Checked/custom exceptions | throws, throw, пользовательский Exception, catch, finally | `caught` |
| Unchecked/custom exceptions | RuntimeException, неперехваченное исключение: тип/сообщение/cause/suppressed и код завершения отдельно от stderr | `uncaught` |
| Вложенная обработка | IOException, IllegalArgumentException, IllegalStateException, RuntimeException, multi-catch, повторный throw из catch, вложенные finally | `multi_catch` |
| Abrupt completion | return через вложенные finally, break/continue через finally, return из finally заменяет ожидающий return; finally внутри finally | `nested_finally`, `finally_override`, `nested_cleanup` |

Файлы: [tests/fixtures/java_coverage](../tests/fixtures/java_coverage).
Каждый из десяти примеров импортируется, экспортируется без изменений и повторно
импортируется, получает структурную правку выбранной операции и проходит настоящий
javac и сравнение двух версий в Docker. Ожидаемые stdout/stderr, исключения и код
завершения заданы литералами в `cases.json`. Текст вне выбранного метода или
конструктора проверяется на сохранение. Браузерный сценарий выбирает конструктор,
затем правит catch и сравнивает результат с кириллицей.

## Как читать исключения на графе

`try`, тела `catch` и `finally` — отдельные последовательности для правок #5.
Операции и выражения имеют возможное ребро исключения. Диспетчер показывает catch
в исходном порядке; Java во время исполнения выбирает первый подходящий тип.
Граф не выполняет resolution типов, не обещает полноту анализа исключений и не
утверждает, что каждый показанный возможный путь достижим.

При входе в finally сохраняется ожидающий переход (`normal`, `return`, `throw`,
`break-N`, `continue-N`) отдельно для данного finally (позиция `Lстрока:колонка`
указана в метке). Вложенный finally не затирает состояние внешнего.
Узел «Продолжить ожидающий переход» выбирает ребро с этим
значением, если сам finally завершился нормально. Это граф с состоянием продолжения,
а не обычный CFG со свободным выбором всех исходящих рёбер. Return/throw/break/continue
из finally заменяет сохранённый переход. Уже вычисленное значение return хранит
Java; генератор не переносит и не переписывает выражение return.

Управляющие узлы выбора catch и продолжения показываются для чтения. Операции
в телах редактируются; параметры catch и throws меняются в текстовом редакторе.
Переходы между областями видимости запрещены. Синтаксическая проверка не определяет
checked exceptions или доступность имён: это проверяет настоящий javac.

`try-with-resources` сохраняется целиком как непрозрачная конструкция с пояснением:
не показываем выдуманный порядок close/suppressed exceptions. Другие границы
описаны в [матрице управления](java-control-flow.md).

Открыто до технического документа: точный перечень java.lang/java.util/java.io,
обязательных реализаций коллекций и исключений, дополнительные консольные API,
версия языка и требования к try-with-resources. Наличие разбора у JavaParser не
означает проверенную поддержку редактором. Потоки, reflection, файлы и время не
включены в обязательную базу; изоляция исполнителя применяется ко всему коду.

```bash
BLUEPRINTS_DOCKER_BIN=docker .venv/bin/pytest tests/test_java_coverage.py -q
BLUEPRINTS_DOCKER_BIN=docker npm run test:e2e -- tests/browser/java-coverage.spec.ts
```
