public class Flow {
  public static void main(String[] args) {
    int total = 0;
    for (int i = 0; i < 3; i++) {
      switch (i) {
        case 0: total += 1;
        case 1: total += 2; break;
        default: continue;
      }
      total += 10;
    }
    System.out.println(total);
  }
}
