interface Value { int get(); }
abstract class Base { abstract int get(); }
class Box extends Base implements Value {
  private final int value;
  static int created = 0;
  Box() { this(3); }
  Box(int value) { this.value = value; created++; }
  public int get() { return value; }
  int get(int extra) { return value + extra; }
}
public class Coverage {
  static class Nested { static final String LABEL = "коробка"; }
  public static void main(String[] args) {
    Box box = new Box();
    Value view = box;
    System.out.println(Nested.LABEL + ":" + view.get() + ":" + box.get(2) + ":" + Box.created);
  }
}
