public class Flow {
  public static void main(String[] args) {
    int total = 0;
    int input = 2;
    switch (input) {
      case 1 -> { total += 1; }
      case 2, 3 -> { total += 4; }
      default -> { total += 10; }
    }
    System.out.println(total);
  }
}
