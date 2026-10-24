public class Flow {
  public static void main(String[] args) {
    int total = 0;
    for (int value : new int[]{1, 2, 3}) {
      if (value == 2) continue;
      total += value;
    }
    System.out.println(total);
  }
}
