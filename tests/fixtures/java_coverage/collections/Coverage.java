import java.util.*;
public class Coverage {
  public static void main(String[] args) {
    Collection<Integer> items = new ArrayList<>(List.of(3, 1, 2));
    List<Integer> list = new LinkedList<>(items);
    Collections.sort(list, Comparator.naturalOrder());
    Set<Integer> hash = new HashSet<>(list);
    Set<Integer> linked = new LinkedHashSet<>(list);
    Set<Integer> sorted = new TreeSet<>(hash);
    Map<String, Integer> map = new HashMap<>(Map.of("x", 2));
    Map<String, Integer> linkedMap = new LinkedHashMap<>(map);
    Map<String, Integer> treeMap = new TreeMap<>(linkedMap);
    Iterable<Integer> iterable = sorted;
    Iterator<Integer> iterator = iterable.iterator();
    int total = 0;
    while (iterator.hasNext()) total += iterator.next();
    int[] array = {3, 1, 2};
    Arrays.sort(array);
    total += 0;
    System.out.println(list + ":" + linked + ":" + Arrays.toString(array));
    System.out.println(total + treeMap.get("x") + Optional.of(4).orElse(0) + Set.of(8, 9).size());
  }
}
