public class Flow {
  public static void main(String[] args) {
    int n = 0, total = 0;
    do {
      n++;
      if (n == 1) continue;
      total += n;
    } while (n < 3);
    System.out.println(total);
  }
}
